import { seal,unseal,publicIdentity } from './crypto';
import { currentPolicy } from './identity';
import type { Replica } from './replica';
import { ReplicaRecords } from './records';
import { invariant } from '@taskasaur/platform/core/errors';
export type Secret=Record<string,string|undefined>;
interface VaultValue { owner:string; sender:ReturnType<typeof publicIdentity>; version:string; recipients:Record<string,string>; revoked:boolean }
export class CredentialVault {
  readonly records:ReplicaRecords;
  constructor(readonly replica:Replica){this.records=new ReplicaRecords(replica);}
  async set(id:string,secret:Secret,deviceIds:string[]=[this.replica.identity.id]){
    const record=this.records.get(id);invariant(record?.collection==='credentials' && record.ownerId===this.replica.member.userId,'PERMISSION_DENIED','Only the credential owner can change secret material');
    const version=crypto.randomUUID(),recipients:Record<string,string>={};
    for(const deviceId of new Set([...deviceIds,this.replica.identity.id])){
      const member=currentPolicy(this.replica.access).members[deviceId];invariant(member,'NOT_FOUND','Credential recipient is not an approved device');
      recipients[deviceId]=await seal(this.replica.identity,member.identity,secret,`${this.replica.workspaceId}:${id}:${version}`);
    }
    await this.replica.update('vault/'+id,{owner:record.ownerId,sender:publicIdentity(this.replica.identity),version,recipients,revoked:false});
    await this.records.put('credentials',{...record.data,status:'ready'},id);
  }
  async use<T>(id:string,pluginId:string,destination:string,execute:(secret:Secret)=>Promise<T>){
    const record=this.records.get(id),value=this.replica.read<VaultValue>('vault/'+id);
    invariant(record?.collection==='credentials' && record.data.status==='ready' && value && !value.revoked,'CREDENTIAL_UNAVAILABLE','Credential is not ready');
    invariant(Array.isArray(record.data.allowed_plugins)&&record.data.allowed_plugins.includes(pluginId),'PERMISSION_DENIED','Credential does not allow this plugin');
    invariant(Array.isArray(record.data.allowed_destinations)&&record.data.allowed_destinations.includes(destination),'PERMISSION_DENIED','Credential does not allow this destination');
    const ciphertext=value.recipients[this.replica.identity.id];invariant(ciphertext,'CREDENTIAL_UNAVAILABLE','Approve this device to use the credential');
    invariant(currentPolicy(this.replica.access).members[value.sender.id],'CREDENTIAL_UNAVAILABLE','Credential issuer has been revoked');
    const secret=await unseal(this.replica.identity,value.sender,ciphertext,`${this.replica.workspaceId}:${id}:${value.version}`) as Secret;
    invariant(!secret.expiresAt || Date.parse(secret.expiresAt)>Date.now(),'CREDENTIAL_EXPIRED','Reconnect this credential');
    return execute(secret);
  }
  async revoke(id:string){
    const record=this.records.get(id);invariant(record?.collection==='credentials'&&record.ownerId===this.replica.member.userId,'PERMISSION_DENIED','Only the credential owner can revoke it');
    const value=this.replica.read<VaultValue>('vault/'+id);if(value)await this.replica.update('vault/'+id,{...value,revoked:true,recipients:{}});
    await this.records.put('credentials',{...record.data,status:'revoked'},id);
  }
}
