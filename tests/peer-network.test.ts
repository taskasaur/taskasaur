import {it,expect} from 'vitest';
import {createIdentity,publicIdentity} from '../packages/core/crypto';
import {createWorkspaceAccess,approveMember,acceptPolicies} from '../packages/core/identity';
import {Replica} from '../packages/core/replica';
import {MemoryStorage} from '../packages/storage';
import {PeerProtocol,PeerSync} from '../packages/sync/protocol';
import {createPeerTransport} from '../packages/sync/libp2p';
it('synchronizes real encrypted libp2p peers, files, and idempotent commands',async()=>{
  const alice=await createIdentity('Laptop'),bob=await createIdentity('Desktop');
  const access=await approveMember(await createWorkspaceAccess(alice,'Network test'),alice,publicIdentity(bob));
  const a=await new Replica(alice,access,new MemoryStorage()).open(),b=await new Replica(bob,await acceptPolicies(bob,access.policies),new MemoryStorage()).open();
  let executions=0;
  const pa=new PeerProtocol(a),pb=new PeerProtocol(b,()=>['test.echo'],async(_command,input)=>{executions++;return input;});
  const ta=await createPeerTransport(a.storage,new Map([[a.workspaceId,pa]]),{listen:['/ip4/127.0.0.1/tcp/0/ws']});
  const tb=await createPeerTransport(b.storage,new Map([[b.workspaceId,pb]]),{listen:['/ip4/127.0.0.1/tcp/0/ws']});
  try{
    await a.update('setting/one',{title:'Persisted on laptop'});
    await b.update('setting/two',{title:'Persisted on desktop'});
    const file=await pb.files.save(crypto.randomUUID(),new TextEncoder().encode('Offline file content'),'text/plain',null);
    const sync=new PeerSync(pa,ta),address=tb.addresses()[0];
    await sync.synchronize(address);
    expect(a.read('setting/two')).toEqual({title:'Persisted on desktop'});
    expect(b.read('setting/one')).toEqual({title:'Persisted on laptop'});
    expect(new TextDecoder().decode((await pa.files.read(file.id)).bytes)).toBe('Offline file content');
    const request={kind:'rpc' as const,command:'test.echo',requestId:crypto.randomUUID(),input:{value:42}};
    expect(await sync.request(address,request)).toEqual({value:42});
    expect(await sync.request(address,request)).toEqual({value:42});expect(executions).toBe(1);
    await expect(sync.request(address,{...request,input:{value:43}})).rejects.toThrow('reused');
  }finally{await ta.close();await tb.close();}
},30000);
