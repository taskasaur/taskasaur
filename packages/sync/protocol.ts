import { canonical, utf8, text, encrypt, decrypt, sign, verify, base64, unbase64, digest } from '../core/crypto';
import { currentPolicy, type Policy } from '../core/identity';
import type { Replica, SignedChange } from '../core/replica';
import { ReplicaFiles } from '../core/files';
import { invariant } from '@taskasaur/platform/core/errors';
export const PEER_PROTOCOL='/taskasaur/replica/1.0.0';
export interface PeerPacket { workspaceId:string; from:string; epoch:number; nonce:string; issuedAt:number; policies:Policy[]; ciphertext:string; signature:string }
export interface PeerRequest { kind:'inventory'|'changes'|'accept'|'blob'|'rpc'|'capabilities'; cursor?:number; hashes?:string[]; changes?:SignedChange[]; hash?:string; requestId?:string; command?:string; input?:unknown }
export interface PeerReply { replyTo:string; result?:unknown; error?:{kind:string;message:string} }
export type CommandHandler=(command:string,input:unknown,context:{deviceId:string;requestId:string})=>Promise<unknown>;
export class PeerProtocol {
  readonly files:ReplicaFiles;
  private nonces=new Map<string,number>();
  private commands:Promise<unknown>=Promise.resolve();
  constructor(readonly replica:Replica,readonly capabilities:()=>string[]=()=>[],private execute?:CommandHandler){this.files=new ReplicaFiles(replica);}
  async pack(value:unknown):Promise<PeerPacket>{
    const policy=currentPolicy(this.replica.access), nonce=crypto.randomUUID();
    const body={workspaceId:this.replica.workspaceId,from:this.replica.identity.id,epoch:policy.epoch,nonce,issuedAt:Date.now(),policies:this.replica.access.policies,ciphertext:await encrypt(this.replica.access.keys[String(policy.epoch)],utf8.encode(canonical(value)),`${this.replica.workspaceId}:${nonce}`)};
    return {...body,signature:await sign(this.replica.identity.privateKey,body)};
  }
  async unpack<T>(packet:PeerPacket):Promise<T>{
    invariant(packet.workspaceId===this.replica.workspaceId && Math.abs(Date.now()-packet.issuedAt)<5*60*1000,'INVALID_PACKET','Peer packet is expired or belongs to another workspace');
    invariant(Array.isArray(packet.policies) && packet.policies[0]?.owner.id===this.replica.access.policies[0].owner.id,'INVALID_POLICY','Unknown workspace owner');
    if(packet.policies.length>this.replica.access.policies.length)await this.replica.setPolicies(packet.policies);
    const member=currentPolicy(this.replica.access).members[packet.from];
    invariant(member,'PERMISSION_DENIED','Peer is not an approved member');
    const {signature,...body}=packet;
    invariant(await verify(member.identity.publicKey,body,signature),'INVALID_SIGNATURE','Peer packet signature is invalid');
    const key=this.replica.access.keys[String(packet.epoch)];invariant(key,'STALE_POLICY','Synchronize membership before sending data');
    const value=JSON.parse(text.decode(await decrypt(key,packet.ciphertext,`${packet.workspaceId}:${packet.nonce}`)));
    return value as T;
  }
  async receive(packet:PeerPacket):Promise<PeerPacket>{
    const request=await this.unpack<PeerRequest>(packet);
    for(const [nonce,expires] of this.nonces)if(expires<Date.now())this.nonces.delete(nonce);
    invariant(!this.nonces.has(packet.nonce),'REPLAY_REJECTED','Peer packet was already processed');
    this.nonces.set(packet.nonce,Date.now()+5*60*1000);
    let reply:PeerReply;
    try{reply={replyTo:packet.nonce,result:await this.handle(request,packet.from)};}
    catch(error){reply={replyTo:packet.nonce,error:{kind:(error as {kind?:string}).kind??'OPERATION_FAILED',message:error instanceof Error?error.message:'Peer operation failed'}};}
    return this.pack(reply);
  }
  private async handle(request:PeerRequest,deviceId:string):Promise<unknown>{
    switch(request.kind){
      case 'inventory':{
        const cursor=request.cursor??0;invariant(Number.isSafeInteger(cursor)&&cursor>=0,'INVALID_CURSOR','Invalid replica cursor');
        const all=this.replica.hashes();return {hashes:all.slice(cursor,cursor+512),next:cursor+512<all.length?cursor+512:null};
      }
      case 'changes':invariant(Array.isArray(request.hashes)&&request.hashes.length<=8,'PAYLOAD_TOO_LARGE','Request at most eight changes');return this.replica.entries(request.hashes);
      case 'accept':invariant(Array.isArray(request.changes)&&request.changes.length<=8,'PAYLOAD_TOO_LARGE','Send at most eight changes');for(const change of request.changes)await this.replica.accept(change);return {accepted:request.changes.map(c=>c.hash)};
      case 'blob':{
        invariant(request.hash && this.files.manifests().some(m=>m.chunks.includes(request.hash!)),'NOT_FOUND','Chunk is not referenced by this workspace');
        const bytes=await this.files.getChunk(request.hash);return bytes?{bytes:base64(bytes)}:null;
      }
      case 'capabilities':return {deviceId:this.replica.identity.id,name:this.replica.identity.name,capabilities:this.capabilities()};
      case 'rpc':{
        invariant(currentPolicy(this.replica.access).members[deviceId].role!=='viewer','PERMISSION_DENIED','Read-only members cannot execute commands');
        invariant(request.command && request.requestId && /^[a-zA-Z0-9_.:-]{1,256}$/.test(request.requestId),'INVALID_COMMAND','Command and operation ID are required');
        invariant(this.execute,'CAPABILITY_UNSUPPORTED','This device does not offer command execution');
        const run=async()=>{
          const key=`workspace/${this.replica.workspaceId}/operations/${deviceId}/${request.requestId}`;
          const hash=await digest(utf8.encode(canonical({command:request.command,input:request.input??null})));
          const existing=await this.replica.storage.get(key);
          if(existing){const result=JSON.parse(text.decode(existing));invariant(result.hash===hash,'IDEMPOTENCY_CONFLICT','Operation ID was reused');invariant(result.state==='complete','OPERATION_UNCERTAIN','Previous execution was interrupted; review its result before retrying');return result.result;}
          await this.replica.storage.set(key,utf8.encode(canonical({hash,state:'started'})));
          const result=await this.execute!(request.command!,request.input,{deviceId,requestId:request.requestId!});
          await this.replica.storage.set(key,utf8.encode(canonical({hash,state:'complete',result:result??null})));
          return result??null;
        };
        const result=this.commands.then(run);this.commands=result.catch(()=>{});return result;
      }
      default:throw Error('Unsupported peer protocol message');
    }
  }
}
export interface PeerTransport { request(address:string,packet:PeerPacket):Promise<PeerPacket>; addresses():string[]; close():Promise<void> }
export class PeerSync {
  constructor(readonly protocol:PeerProtocol,readonly transport:PeerTransport){}
  async request<T>(address:string,request:PeerRequest):Promise<T>{
    const packet=await this.protocol.pack(request),response=await this.transport.request(address,packet),reply=await this.protocol.unpack<PeerReply>(response);
    invariant(reply.replyTo===packet.nonce,'INVALID_PACKET','Peer response does not match the request');
    if(reply.error)throw Object.assign(new Error(reply.error.message),{kind:reply.error.kind});
    return reply.result as T;
  }
  async synchronize(address:string){
    const remote=new Set<string>();let cursor:number|null=0;
    do{const page: {hashes:string[];next:number|null}=await this.request(address,{kind:'inventory',cursor});for(const hash of page.hashes)remote.add(hash);cursor=page.next;}while(cursor!==null);
    const local=new Set(this.protocol.replica.hashes()),download=[...remote].filter(h=>!local.has(h)),upload=[...local].filter(h=>!remote.has(h));
    for(let i=0;i<download.length;i+=8)for(const change of await this.request<SignedChange[]>(address,{kind:'changes',hashes:download.slice(i,i+8)}))await this.protocol.replica.accept(change);
    for(let i=0;i<upload.length;i+=8)await this.request(address,{kind:'accept',changes:this.protocol.replica.entries(upload.slice(i,i+8))});
    for(const hash of await this.protocol.files.missing()){
      const result=await this.request<{bytes:string}|null>(address,{kind:'blob',hash});
      if(result)await this.protocol.files.putChunk(hash,unbase64(result.bytes));
    }
    return {uploaded:upload.length,downloaded:download.length,missingFiles:(await this.protocol.files.missing()).length};
  }
}
