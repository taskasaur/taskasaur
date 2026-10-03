import type { Replica } from './replica';
import type { ResourceRecord } from '@taskasaur/platform/plugin-sdk';
import { getSchema } from '@taskasaur/platform/core/catalog';
import { queryRecords, validateRecord, type Query, type Value } from '@taskasaur/platform/field-types';
import { validateDynamicData,validateTableValues } from '@taskasaur/platform/core/dynamic-fields';
import { invariant } from '@taskasaur/platform/core/errors';
export function deviceRecordId(identityId:string){return `${identityId.slice(0,8)}-${identityId.slice(8,12)}-4${identityId.slice(13,16)}-8${identityId.slice(17,20)}-${identityId.slice(20,32)}`;}
export class ReplicaRecords {
  constructor(readonly replica:Replica){}
  get(id:string){return this.replica.read<ResourceRecord>('record/'+id);}
  all(){return this.replica.ids('record/').flatMap(id=>this.replica.read<ResourceRecord>(id)??[]);}
  list(collection:string,query:Query={}){return queryRecords(this.all().filter(r=>r.collection===collection&&!r.deletedAt),getSchema(collection),query);}
  canWrite(){return Boolean(this.replica.member && this.replica.member.role!=='viewer');}
  async put(collection:string,input:unknown,id=crypto.randomUUID(),options:{ownerId?:string;createdAt?:string}={}) {
    const schema=getSchema(collection),data=validateRecord(schema,input),old=this.get(id);
    invariant(this.canWrite(),'PERMISSION_DENIED','Workspace is read only');
    invariant(!old||old.collection===collection,'PERMISSION_DENIED','Resource kind cannot change');
    validateDynamicData(collection,data);
    if(collection==='table_rows'){
      const definition=this.get(String(data.table_id));invariant(definition?.collection==='tables'&&!definition.deletedAt,'NOT_FOUND','Table definition was not found');
      data.values=validateTableValues(definition.data.columns,data.values);
    }
    const now=new Date().toISOString();
    const record:ResourceRecord={id,workspaceId:this.replica.workspaceId,ownerId:old?.ownerId??options.ownerId??this.replica.member.userId,pluginId:schema.pluginId,collection,revision:(old?.revision??0)+1,createdAt:old?.createdAt??options.createdAt??now,updatedAt:now,deletedAt:null,data};
    await this.replica.update('record/'+id,record as unknown as Record<string,unknown>);
    return this.get(id)!;
  }
  async delete(id:string){const old=this.get(id);invariant(old,'NOT_FOUND','Record not found');await this.replica.update('record/'+id,{...old,deletedAt:new Date().toISOString(),revision:old.revision+1});}
  async resolve(id:string,field:string,value:Value){const record=this.get(id);invariant(record,'NOT_FOUND','Record not found');return this.put(record.collection,{...record.data,[field]:value},id);}
}
