import * as A from '@automerge/automerge';
import type { DurableStorage } from '../storage';
import { canonical, base64, unbase64, digest, utf8, text, sign, verify, encrypt, decrypt, type Identity } from './crypto';
import { acceptPolicies, currentPolicy, type WorkspaceAccess, type Policy } from './identity';
import { invariant } from '@taskasaur/platform/core/errors';
import type { ResourceRecord } from '@taskasaur/platform/plugin-sdk';
import { validateRecord } from '@taskasaur/platform/field-types';
import { schemaById } from '@taskasaur/platform/core/catalog';
export type DocumentValue = { value: Record<string,unknown> };
export interface ChangeBody { version:1; workspaceId:string; documentId:string; author:string; epoch:number; hash:string; change:string }
export interface SignedChange extends ChangeBody { signature:string }
export interface ReplicaStatus { documents:number; changes:number; quarantined:number; pending:number; peers:number; error?:string }
/** One replica per workspace/device. Changes are signed individually so untrusted relays cannot forge forwarded edits. */
export class Replica {
  private documents=new Map<string,A.Doc<DocumentValue>>();
  private changes=new Map<string,SignedChange>();
  private queue:Promise<unknown>=Promise.resolve();
  readonly listeners=new Set<(id:string)=>void>();
  readonly outgoing=new Set<(change:SignedChange)=>void>();
  readonly policyListeners=new Set<()=>void>();
  quarantined=0;
  peers=0;
  error='';
  constructor(readonly identity:Identity, public access:WorkspaceAccess, readonly storage:DurableStorage) {}
  get workspaceId(){return currentPolicy(this.access).workspaceId;}
  get member(){return currentPolicy(this.access).members[this.identity.id];}
  private prefix(){return `workspace/${this.workspaceId}/`;}
  private serial<T>(work:()=>Promise<T>):Promise<T> {
    const next=this.queue.then(work); this.queue=next.catch(()=>{}); return next;
  }
  async open() {
    const saved=await this.storage.get(this.prefix()+'access');
    if(saved) this.access=await acceptPolicies(this.identity,JSON.parse(text.decode(saved)) as Policy[],this.access);
    else await this.storage.set(this.prefix()+'access',utf8.encode(canonical(this.access.policies)));
    for(const key of await this.storage.keys(this.prefix()+'changes/')) {
      const saved=JSON.parse(text.decode((await this.storage.get(key))!)) as {epoch:number;ciphertext:string};
      const entry=JSON.parse(text.decode(await decrypt(this.access.keys[String(saved.epoch)],saved.ciphertext,key))) as SignedChange;
      try {await this.acceptInternal(entry,false);} catch(error) {this.quarantined++;this.error=String(error);}
    }
    return this;
  }
  status():ReplicaStatus {
    return {documents:this.documents.size,changes:this.changes.size,quarantined:this.quarantined,pending:[...this.documents.values()].reduce((n,d)=>n+A.getMissingDeps(d, []).length,0),peers:this.peers,...(this.error?{error:this.error}:{})};
  }
  ids(prefix=''){return [...this.documents.keys()].filter(id=>id.startsWith(prefix));}
  read<T=Record<string,unknown>>(id:string):T|undefined {
    const doc=this.documents.get(id); return doc?.value ? structuredClone(A.toJS(doc).value) as T : undefined;
  }
  conflicts(id:string, field:string, nested=false) {
    const doc=this.documents.get(id); if(!doc?.value)return {};
    const object=nested ? doc.value.data as Record<string,unknown> : doc.value;
    return A.getConflicts(object,field) ?? {};
  }
  async update(id:string,value:Record<string,unknown>) {
    return this.serial(async()=>{
      invariant(this.member && this.member.role!=='viewer','PERMISSION_DENIED','This device cannot edit this workspace');
      invariant(/^(record|setting|file|event|job|vault)\/[a-zA-Z0-9_.:-]{1,256}$/.test(id),'INVALID_DOCUMENT','Invalid document identifier');
      invariant(utf8.encode(canonical(value)).length<=2*1024*1024,'PAYLOAD_TOO_LARGE','Store large content through the file service');
      const previous=this.documents.get(id) ?? A.init<DocumentValue>({actor:this.identity.id});
      const draft=A.clone(previous,{actor:this.identity.id});
      const next=A.change(draft,doc=>{
        if(!doc.value)doc.value={};
        // Patch fields individually: replacing the entire record discards concurrent independent edits.
        for(const key of new Set([...Object.keys(doc.value),...Object.keys(value)])) {
          if(!(key in value)) {delete doc.value[key];continue;}
          if(key==='data' && value.data && typeof value.data==='object' && !Array.isArray(value.data)) {
            if(!doc.value.data)doc.value.data={};
            const target=doc.value.data as Record<string,unknown>, incoming=value.data as Record<string,unknown>;
            for(const field of new Set([...Object.keys(target),...Object.keys(incoming)])) {
              if(!(field in incoming))delete target[field];
              else if(canonical(target[field])!==canonical(incoming[field]))target[field]=structuredClone(incoming[field]);
            }
          } else if(canonical(doc.value[key])!==canonical(value[key]))doc.value[key]=structuredClone(value[key]);
        }
      });
      const change=A.getLastLocalChange(next);
      if(!change || A.getHeads(previous).join()===A.getHeads(next).join())return;
      const decoded=A.decodeChange(change);
      const body:ChangeBody={version:1,workspaceId:this.workspaceId,documentId:id,author:this.identity.id,epoch:currentPolicy(this.access).epoch,hash:decoded.hash!,change:base64(change)};
      const entry={...body,signature:await sign(this.identity.privateKey,body)};
      await this.acceptInternal(entry,true);
      for(const listener of this.outgoing)listener(entry);
    });
  }
  async accept(entry:SignedChange) {return this.serial(()=>this.acceptInternal(entry,true));}
  private async acceptInternal(entry:SignedChange,persist:boolean) {
    invariant(entry.version===1 && entry.workspaceId===this.workspaceId && /^[a-f0-9]{64}$/.test(entry.hash),'INVALID_CHANGE','Invalid change envelope');
    if(this.changes.has(entry.hash))return;
    invariant(/^(record|setting|file|event|job|vault)\/[a-zA-Z0-9_.:-]{1,256}$/.test(entry.documentId) && entry.change.length<=4*1024*1024,'INVALID_CHANGE','Change exceeds the document limits');
    const policy=this.access.policies[entry.epoch-1], member=policy?.members[entry.author];
    invariant(member && member.role!=='viewer','PERMISSION_DENIED','Change author was not permitted to write');
    const cutoff=currentPolicy(this.access).revoked[entry.author];
    invariant(!cutoff || cutoff.includes(entry.hash),'REVOKED','Change was not approved before the device was revoked');
    const {signature,...body}=entry;
    invariant(await verify(member.identity.publicKey,body,signature),'INVALID_SIGNATURE','Change signature is invalid');
    const bytes=unbase64(entry.change), decoded=A.decodeChange(bytes);
    invariant(decoded.actor===entry.author && decoded.hash===entry.hash,'INVALID_CHANGE','Change identity or hash mismatch');
    // Dependencies cannot cross record boundaries, even when their hashes are valid.
    for(const dep of decoded.deps)invariant(!this.changes.has(dep)||this.changes.get(dep)!.documentId===entry.documentId,'INVALID_CHANGE','Cross-document dependency');
    const previous=this.documents.get(entry.documentId) ?? A.init<DocumentValue>({actor:this.identity.id});
    const [next]=A.applyChanges(A.clone(previous,{actor:this.identity.id}),[bytes]);
    if(next.value && !A.getMissingDeps(next, []).length) {
      invariant(typeof next.value==='object' && !Array.isArray(next.value),'INVALID_CHANGE','Invalid document value');
      if(entry.documentId.startsWith('record/')) {
        invariant(next.value.id===entry.documentId.slice(7),'INVALID_RECORD','Document and resource identity differ');
        this.validateResource(next.value as unknown as ResourceRecord,previous.value as unknown as ResourceRecord|undefined);
      }
    }
    if(persist) {
      const key=this.prefix()+'changes/'+entry.hash, epoch=currentPolicy(this.access).epoch;
      const ciphertext=await encrypt(this.access.keys[String(epoch)],utf8.encode(canonical(entry)),key);
      await this.storage.set(key,utf8.encode(canonical({epoch,ciphertext})));
    }
    this.documents.set(entry.documentId,next);this.changes.set(entry.hash,entry);
    for(const listener of this.listeners)listener(entry.documentId);
  }
  private validateResource(record:ResourceRecord,previous?:ResourceRecord) {
    invariant(record.workspaceId===this.workspaceId && typeof record.id==='string' && record.data && typeof record.collection==='string','INVALID_RECORD','Resource scope is invalid');
    if(previous)for(const field of ['id','workspaceId','ownerId','pluginId','collection','createdAt'] as const)invariant(record[field]===previous[field],'INVALID_RECORD',`Immutable field changed: ${field}`);
    // Unknown plugin data can replicate without installing or executing its package.
    const schema=schemaById.get(record.collection);
    if(schema){invariant(schema.pluginId===record.pluginId,'INVALID_RECORD','Collection owner mismatch');validateRecord(schema,record.data);}
  }
  entries(hashes?:string[]) {return hashes ? hashes.flatMap(h=>this.changes.get(h)?[this.changes.get(h)!]:[]) : [...this.changes.values()];}
  hashes(){return [...this.changes.keys()];}
  async setPolicies(policies:Policy[]) {
    return this.serial(async()=>{
      const access=await acceptPolicies(this.identity,policies,this.access);
      await this.storage.set(this.prefix()+'access',utf8.encode(canonical(policies)));this.access=access;
      // Membership changes are owner-signed; never merge them as ordinary editable records.
      const entries=[...this.changes.values()];this.documents.clear();this.changes.clear();this.quarantined=0;
      for(const entry of entries)try{await this.acceptInternal(entry,false);}catch{this.quarantined++;}
      for(const listener of this.policyListeners)listener();
      for(const id of this.ids())for(const listener of this.listeners)listener(id);
    });
  }
  async flush(){await this.queue;}
}
