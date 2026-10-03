import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport, circuitRelayServer } from '@libp2p/circuit-relay-v2';
import { identify } from '@libp2p/identify';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { generateKeyPair, privateKeyFromProtobuf, privateKeyToProtobuf } from '@libp2p/crypto/keys';
import { multiaddr } from '@multiformats/multiaddr';
import type { Stream } from '@libp2p/interface';
import type { DurableStorage } from '../storage';
import { text, utf8 } from '../core/crypto';
import { invariant } from '@taskasaur/platform/core/errors';
import { PEER_PROTOCOL, type PeerPacket, type PeerProtocol, type PeerTransport } from './protocol';
const MAX_FRAME=32*1024*1024;
async function send(stream:Stream,value:unknown){
  const bytes=utf8.encode(JSON.stringify(value));invariant(bytes.length<=MAX_FRAME,'PAYLOAD_TOO_LARGE','Peer frame is too large');
  const header=new Uint8Array(4);new DataView(header.buffer).setUint32(0,bytes.length);
  if(!stream.send(header))await stream.onDrain({signal:AbortSignal.timeout(30000)});
  for(let i=0;i<bytes.length;i+=64*1024)if(!stream.send(bytes.subarray(i,i+64*1024)))await stream.onDrain({signal:AbortSignal.timeout(30000)});
}
async function receive(stream:Stream):Promise<PeerPacket>{
  let buffer=new Uint8Array(0),length=-1;
  for await(const part of stream){
    const bytes=part instanceof Uint8Array?part:part.subarray();
    invariant(buffer.length+bytes.length<=MAX_FRAME+4,'PAYLOAD_TOO_LARGE','Peer frame is too large');
    const joined=new Uint8Array(buffer.length+bytes.length);joined.set(buffer);joined.set(bytes,buffer.length);buffer=joined;
    if(length<0 && buffer.length>=4){length=new DataView(buffer.buffer).getUint32(0);invariant(length<=MAX_FRAME,'PAYLOAD_TOO_LARGE','Peer frame is too large');}
    if(length>=0 && buffer.length>=length+4){invariant(buffer.length===length+4,'INVALID_PACKET','Unexpected trailing peer data');return JSON.parse(text.decode(buffer.subarray(4)));}
  }
  throw Error('Peer disconnected before finishing the response');
}
export interface NetworkOptions { listen?:string[]; relay?:boolean; webRTC?:boolean; bootstrap?:string[] }
export async function createPeerTransport(storage:DurableStorage,protocols:Map<string,PeerProtocol>,options:NetworkOptions={}):Promise<PeerTransport>{
  const saved=await storage.get('network/private-key');const privateKey=saved?privateKeyFromProtobuf(saved):await generateKeyPair('Ed25519');
  if(!saved)await storage.set('network/private-key',privateKeyToProtobuf(privateKey));
  const transports=[webSockets(),circuitRelayTransport()];
  if(options.webRTC){const {webRTC}=await import('@libp2p/webrtc');transports.push(webRTC());}
  const node=await createLibp2p({privateKey,addresses:{listen:options.listen??[]},transports,connectionEncrypters:[noise()],streamMuxers:[yamux()],connectionGater:{denyDialMultiaddr:()=>false},services:{identify:identify(),...(options.relay?{relay:circuitRelayServer()}: {})}});
  await node.handle(PEER_PROTOCOL,async stream=>{
    stream.inactivityTimeout=30000;
    try{
      const packet=await receive(stream),protocol=protocols.get(packet.workspaceId);
      invariant(protocol,'NOT_FOUND','Workspace is not hosted by this device');
      await send(stream,await protocol.receive(packet));await stream.close();
    }catch(error){stream.abort(error instanceof Error?error:new Error('Peer request failed'));}
  },{maxInboundStreams:16,runOnLimitedConnection:true});
  for(const address of options.bootstrap??[])await node.dial(multiaddr(address),{signal:AbortSignal.timeout(10000)}).catch(()=>{});
  return {
    addresses:()=>node.getMultiaddrs().map(a=>a.toString()),
    async request(address,packet){
      const stream=await node.dialProtocol(multiaddr(address),PEER_PROTOCOL,{signal:AbortSignal.timeout(15000),runOnLimitedConnection:true});
      stream.inactivityTimeout=30000;
      try{await send(stream,packet);const result=await receive(stream);await stream.close();return result;}
      catch(error){stream.abort(error instanceof Error?error:new Error('Peer request failed'));throw error;}
    },
    close:async()=>{await node.stop();},
  };
}
