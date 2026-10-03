import type { Replica } from './replica';
import { digest, encrypt, decrypt, utf8, text, canonical } from './crypto';
import { currentPolicy } from './identity';
import { invariant } from '@taskasaur/platform/core/errors';
export interface FileManifest { id:string; fileId:string; parentVersionId:string|null; mediaType:string; size:number; checksum:string; chunks:string[]; createdAt:string }
export const CHUNK_BYTES=256*1024;
export class ReplicaFiles {
  constructor(readonly replica:Replica){}
  private key(hash:string){invariant(/^[a-f0-9]{64}$/.test(hash),'INVALID_HASH','Invalid chunk hash');return `workspace/${this.replica.workspaceId}/blobs/${hash}`;}
  async putChunk(hash:string,bytes:Uint8Array) {
    invariant(bytes.length<=CHUNK_BYTES && await digest(bytes)===hash,'INTEGRITY_FAILED','File chunk does not match its checksum');
    const key=this.key(hash); if(await this.replica.storage.get(key))return;
    const epoch=currentPolicy(this.replica.access).epoch;
    const ciphertext=await encrypt(this.replica.access.keys[String(epoch)],bytes,key);
    await this.replica.storage.set(key,utf8.encode(canonical({epoch,ciphertext})));
  }
  async getChunk(hash:string){
    const key=this.key(hash),stored=await this.replica.storage.get(key);if(!stored)return undefined;
    const value=JSON.parse(text.decode(stored));
    const bytes=await decrypt(this.replica.access.keys[String(value.epoch)],value.ciphertext,key);
    invariant(await digest(bytes)===hash,'INTEGRITY_FAILED','Stored file chunk is corrupt');return bytes;
  }
  async save(fileId:string,bytes:Uint8Array,mediaType:string,parentVersionId:string|null,id=crypto.randomUUID()) {
    invariant(bytes.length<=512*1024*1024,'PAYLOAD_TOO_LARGE','File exceeds the 512 MB limit');
    const chunks:string[]=[];
    for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES){const chunk=bytes.slice(offset,offset+CHUNK_BYTES),hash=await digest(chunk);await this.putChunk(hash,chunk);chunks.push(hash);}
    const manifest:FileManifest={id,fileId,parentVersionId,mediaType,size:bytes.length,checksum:await digest(bytes),chunks,createdAt:new Date().toISOString()};
    const previous=this.replica.read<FileManifest>('file/'+id);
    invariant(!previous || canonical(previous)===canonical({...manifest,createdAt:previous.createdAt}),'IDEMPOTENCY_CONFLICT','File version contains different content');
    if(!previous)await this.replica.update('file/'+id,manifest as unknown as Record<string,unknown>);
    return previous??manifest;
  }
  manifests(){return this.replica.ids('file/').flatMap(id=>this.replica.read<FileManifest>(id)??[]);}
  async missing(){
    const missing:string[]=[];
    for(const hash of new Set(this.manifests().flatMap(m=>m.chunks)))if(!await this.replica.storage.get(this.key(hash)))missing.push(hash);
    return missing;
  }
  async read(versionId:string) {
    const manifest=this.replica.read<FileManifest>('file/'+versionId);invariant(manifest,'NOT_FOUND','File version does not exist');
    invariant(manifest.size<=512*1024*1024 && manifest.chunks.length<=2048,'INVALID_FILE','Invalid file manifest');
    const bytes=new Uint8Array(manifest.size);let offset=0;
    for(const hash of manifest.chunks){const chunk=await this.getChunk(hash);invariant(chunk,'OFFLINE_UNAVAILABLE','File is still downloading');invariant(offset+chunk.length<=bytes.length,'INVALID_FILE','File length mismatch');bytes.set(chunk,offset);offset+=chunk.length;}
    invariant(offset===bytes.length && await digest(bytes)===manifest.checksum,'INTEGRITY_FAILED','File checksum mismatch');
    return {manifest,bytes};
  }
}
