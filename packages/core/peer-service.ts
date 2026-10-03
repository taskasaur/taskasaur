import type { WorkspaceNode } from "./device";
import { currentPolicy } from "./identity";
import { deviceRecordId } from "./records";
import type {
  PeerService,
  PeerDevice,
} from "@taskasaur/platform/plugin-sdk/peers";
export function peerService(node: WorkspaceNode): PeerService {
  const list = async (): Promise<PeerDevice[]> =>
    Object.values(currentPolicy(node.replica.access).members).map((member) => {
      const self = member.identity.id === node.replica.identity.id,
        peer = node.peerDevices.get(member.identity.id);
      return {
        id: member.identity.id,
        recordId: deviceRecordId(member.identity.id),
        name: member.identity.name,
        online: self || Boolean(peer && Date.now() - peer.lastSeen < 45000),
        capabilities: self
          ? node.protocol.capabilities()
          : (peer?.capabilities ?? []),
        lastSeen: self
          ? new Date().toISOString()
          : peer
            ? new Date(peer.lastSeen).toISOString()
            : null,
      };
    });
  return {
    list,
    self: async () =>
      (await list()).find((p) => p.id === node.replica.identity.id)!,
    supports: async (id, capability) =>
      Boolean(
        (await list())
          .find((p) => p.id === id || p.recordId === id)
          ?.capabilities.includes(capability),
      ),
  };
}
