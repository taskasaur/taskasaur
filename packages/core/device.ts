import { deleteWorkspaceData, type DurableStorage } from "../storage";
import {
  createIdentity,
  canonical,
  text,
  utf8,
  publicIdentity,
  type Identity,
  type PublicIdentity,
} from "./crypto";
import {
  createWorkspaceAccess,
  acceptPolicies,
  approveMember,
  revokeMember,
  currentPolicy,
  type Policy,
  type Role,
  type DeviceDelegation,
} from "./identity";
import { Replica } from "./replica";
import { ReplicaRecords, deviceRecordId } from "./records";
import { CredentialVault } from "./vault";
import {
  PeerProtocol,
  PeerSync,
  type PeerTransport,
  type CommandHandler,
} from "../sync/protocol";
import { invariant } from "@taskasaur/platform/core/errors";
import { LocalState } from "./local-state";
export interface LinkedWorkspace {
  id: string;
  name: string;
  policies: Policy[];
  peers: string[];
  delegations?: DeviceDelegation[];
}
export class WorkspaceNode {
  readonly records: ReplicaRecords;
  readonly vault: CredentialVault;
  readonly protocol: PeerProtocol;
  sync?: PeerSync;
  readonly peerDevices = new Map<
    string,
    {
      address: string;
      deviceId: string;
      name: string;
      capabilities: string[];
      lastSeen: number;
    }
  >();
  private synchronization?: Promise<void>;
  private commandQueue?: Promise<void>;
  private closed = false;
  constructor(
    readonly replica: Replica,
    public link: LinkedWorkspace,
    capabilities: () => string[] = () => [],
    handler?: CommandHandler,
  ) {
    this.records = new ReplicaRecords(replica);
    this.vault = new CredentialVault(
      replica,
      async (deviceId, id, pluginId, destination) => {
        await this.call(
          "credentials.refresh",
          { id, pluginId, destination },
          deviceId,
        );
        await this.synchronize();
      },
    );
    this.protocol = new PeerProtocol(replica, capabilities, handler);
    this.protocol.connections.add((id, address) => {
      const old = this.peerDevices.get(id),
        member = currentPolicy(replica.access).members[id];
      this.peerDevices.set(id, {
        address,
        deviceId: id,
        name: member.identity.name,
        capabilities: old?.capabilities ?? [],
        lastSeen: Date.now(),
      });
    });
  }
  async synchronize() {
    if (this.closed) return;
    if (this.synchronization) return this.synchronization;
    const work = async () => {
      if (!this.sync) {
        await this.protocol.storage.reconcile(async () => false);
        return;
      }
      const errors: string[] = [];
      for (const address of new Set([
        ...this.link.peers,
        ...[...this.peerDevices.values()]
          .filter((p) => Date.now() - p.lastSeen < 45000)
          .map((p) => p.address),
      ]))
        try {
          await this.sync.synchronize(address);
          const info = await this.sync.request<{
            deviceId: string;
            name: string;
            capabilities: string[];
          }>(address, { kind: "capabilities" });
          this.peerDevices.set(info.deviceId, {
            address,
            ...info,
            lastSeen: Date.now(),
          });
        } catch (error) {
          errors.push(error instanceof Error ? error.message : String(error));
        }
      await this.protocol.storage.reconcile(async (item, version) => {
        for (const peer of this.peerDevices.values()) {
          if (
            Date.now() - peer.lastSeen >= 45000 ||
            !peer.capabilities.includes("storage.placement") ||
            !this.protocol.storage.wanted(item, peer.deviceId)
          )
            continue;
          try {
            const receipt = await this.sync!.request<{
              deviceId: string;
              token: string;
            }>(
              peer.address,
              { kind: "storage-retain", item, version },
              peer.deviceId,
            );
            if (
              receipt.deviceId === peer.deviceId &&
              receipt.token === version.token
            )
              return true;
          } catch {
            /* Keep the local copy until a peer can confirm this exact version. */
          }
        }
        return false;
      });
      this.replica.peers = [...this.peerDevices.values()].filter(
        (p) => Date.now() - p.lastSeen < 45000,
      ).length;
      this.replica.error = errors.join("; ");
    };
    this.synchronization = work().finally(() => {
      this.synchronization = undefined;
    });
    return this.synchronization;
  }
  async call(
    command: string,
    input: unknown,
    targetDeviceId?: string,
    requestId: string = crypto.randomUUID(),
  ) {
    invariant(!this.closed, "WORKSPACE_CLOSED", "This workspace is closed");
    if (
      targetDeviceId === this.replica.identity.id ||
      targetDeviceId === deviceRecordId(this.replica.identity.id)
    )
      return this.protocol.localCall(command, input, requestId);
    invariant(this.sync, "OFFLINE", "Peer networking is unavailable");
    const eligible = [...this.peerDevices.values()].filter(
      (p) =>
        (!targetDeviceId ||
          p.deviceId === targetDeviceId ||
          deviceRecordId(p.deviceId) === targetDeviceId) &&
        Date.now() - p.lastSeen < 45000 &&
        (p.capabilities.includes(command) ||
          p.capabilities.includes(command.split(".")[0] + ".*")),
    );
    invariant(
      eligible.length,
      "DEVICE_UNAVAILABLE",
      "No online approved device offers this operation",
    );
    return this.sync.request(
      eligible[0].address,
      { kind: "rpc", command, input, requestId },
      eligible[0].deviceId,
    );
  }
  async enqueue(
    command: string,
    input: unknown,
    targetDeviceId: string,
    requestId: string,
    expiresAt: number,
  ) {
    invariant(
      targetDeviceId &&
        expiresAt > Date.now() &&
        expiresAt - Date.now() <= 86400000,
      "INVALID_COMMAND",
      "Queued commands require a selected device and expiry within 24 hours",
    );
    const store = new LocalState(this.replica, "outgoing-commands"),
      previous = await store.get<{
        command: string;
        input: unknown;
        targetDeviceId: string;
      }>(requestId);
    if (previous)
      invariant(
        canonical({
          command: previous.command,
          input: previous.input,
          targetDeviceId: previous.targetDeviceId,
        }) === canonical({ command, input, targetDeviceId }),
        "IDEMPOTENCY_CONFLICT",
        "Command ID was reused",
      );
    else
      await store.set(requestId, {
        command,
        input,
        targetDeviceId,
        expiresAt,
        status: "queued",
      });
  }
  async flushCommands() {
    if (this.closed) return;
    if (this.commandQueue) return this.commandQueue;
    this.commandQueue = (async () => {
      const store = new LocalState(this.replica, "outgoing-commands");
      for (const id of await store.ids()) {
        const value = await store.get<{
          command: string;
          input: unknown;
          targetDeviceId: string;
          expiresAt: number;
          status: string;
          error?: string;
        }>(id);
        if (!value || value.status !== "queued") continue;
        if (value.expiresAt < Date.now()) {
          value.status = "expired";
          value.error =
            "Selected device did not accept this command before its deadline";
        } else
          try {
            await this.call(
              value.command,
              value.input,
              value.targetDeviceId,
              id,
            );
            value.status = "accepted";
            delete value.error;
          } catch (error) {
            const kind = (error as { kind?: string }).kind;
            if (kind && !["DEVICE_UNAVAILABLE", "OFFLINE"].includes(kind))
              value.status = "failed";
            value.error =
              error instanceof Error ? error.message : String(error);
          }
        await store.set(id, value);
      }
    })().finally(() => {
      this.commandQueue = undefined;
    });
    return this.commandQueue;
  }
  async stop() {
    this.closed = true;
    await Promise.allSettled([this.synchronization, this.commandQueue]);
    await this.protocol.close();
    await this.replica.flush();
    this.sync = undefined;
    this.peerDevices.clear();
    this.replica.deactivate();
  }
}
export class DeviceCore {
  readonly workspaces = new Map<string, WorkspaceNode>();
  readonly protocols = new Map<string, PeerProtocol>();
  private links: LinkedWorkspace[] = [];
  transport?: PeerTransport;
  private constructor(
    readonly identity: Identity,
    readonly storage: DurableStorage,
    private capabilities: () => string[],
  ) {}
  static async open(
    storage: DurableStorage,
    name: string,
    capabilities: () => string[] = () => [],
  ) {
    const saved = await storage.get("device/identity");
    const identity = saved
      ? (JSON.parse(text.decode(saved)) as Identity)
      : await createIdentity(name);
    if (!saved)
      await storage.set("device/identity", utf8.encode(canonical(identity)));
    const core = new DeviceCore(identity, storage, capabilities),
      links = await storage.get("device/workspaces");
    core.links = links ? JSON.parse(text.decode(links)) : [];
    return core;
  }
  profiles() {
    return this.links.map((link) => ({ ...link }));
  }
  setCapabilities(provider: () => string[]) {
    this.capabilities = provider;
  }
  async workspace(id: string, handler?: CommandHandler) {
    const existing = this.workspaces.get(id);
    if (existing) {
      if (handler) existing.protocol.setHandler(handler);
      return existing;
    }
    const link = this.links.find((l) => l.id === id);
    invariant(link, "NOT_FOUND", "Workspace is not linked to this device");
    const storedCredential = await this.storage.get(
      `workspace/${id}/local/connection-credential`,
    );
    const access = await acceptPolicies(
      this.identity,
      link.policies,
      undefined,
      storedCredential ? JSON.parse(text.decode(storedCredential)) : undefined,
      link.delegations,
    );
    const replica = await new Replica(
      this.identity,
      access,
      this.storage,
    ).open();
    const node = new WorkspaceNode(
      replica,
      link,
      () => this.capabilities(),
      handler,
    );
    this.workspaces.set(id, node);
    await node.records.open();
    await node.protocol.files.initialize();
    await node.protocol.storage.bootstrap();
    this.protocols.set(id, node.protocol);
    if (this.transport) node.sync = new PeerSync(node.protocol, this.transport);
    replica.policyListeners.add(() => {
      link.policies = replica.access.policies;
      link.delegations = replica.access.delegations ?? [];
      void this.persistLinks().catch((error) => {
        replica.error = String(error);
      });
    });
    return node;
  }
  private persistLinks() {
    return this.storage.set(
      "device/workspaces",
      utf8.encode(canonical(this.links)),
    );
  }
  async createWorkspace(name: string, id?: string, userId?: string) {
    const access = await createWorkspaceAccess(this.identity, name, id, userId),
      policy = currentPolicy(access);
    this.links.push({
      id: policy.workspaceId,
      name,
      policies: access.policies,
      peers: [],
    });
    await this.persistLinks();
    return this.workspace(policy.workspaceId);
  }
  pairingRequest() {
    return JSON.stringify({
      format: "taskasaur-device-request-v1",
      identity: publicIdentity(this.identity),
    });
  }
  async approve(
    workspaceId: string,
    request: string,
    role: Role = "editor",
    userId?: string,
  ) {
    const parsed = JSON.parse(request) as {
      format: string;
      identity: PublicIdentity;
    };
    invariant(
      parsed.format === "taskasaur-device-request-v1",
      "INVALID_INVITATION",
      "Invalid device request",
    );
    const node = await this.workspace(workspaceId),
      access = await approveMember(
        node.replica.access,
        this.identity,
        parsed.identity,
        role,
        userId,
      );
    await node.replica.setPolicies(access.policies);
    await this.persistLinks();
    return JSON.stringify({
      format: "taskasaur-pairing-v1",
      policies: access.policies,
      peers: [
        ...new Set([
          ...(this.transport?.addresses() ?? []),
          ...node.link.peers,
        ]),
      ].filter((address) => address !== "local:desktop"),
    });
  }
  async join(invitation: string, credential?: Identity) {
    const parsed = JSON.parse(invitation) as {
      format: string;
      policies: Policy[];
      peers: string[];
      delegations?: DeviceDelegation[];
    };
    invariant(
      parsed.format === "taskasaur-pairing-v1",
      "INVALID_INVITATION",
      "Invalid pairing invitation",
    );
    const storedCredential = await this.storage.get(
      `workspace/${parsed.policies.at(-1)?.workspaceId}/local/connection-credential`,
    );
    credential ??= storedCredential
      ? JSON.parse(text.decode(storedCredential))
      : undefined;
    const access = await acceptPolicies(
        this.identity,
        parsed.policies,
        undefined,
        credential,
        parsed.delegations,
      ),
      policy = currentPolicy(access);
    if (credential)
      await this.storage.set(
        `workspace/${policy.workspaceId}/local/connection-credential`,
        utf8.encode(canonical(credential)),
      );
    const existing = this.links.find((l) => l.id === policy.workspaceId);
    if (existing) {
      const node = await this.workspace(existing.id);
      await node.replica.setPolicies(parsed.policies);
      await node.replica.setDelegations(parsed.delegations ?? []);
      existing.peers = [...new Set([...existing.peers, ...parsed.peers])];
    } else
      this.links.push({
        id: policy.workspaceId,
        name: policy.name,
        policies: parsed.policies,
        peers: parsed.peers,
        delegations: parsed.delegations ?? [],
      });
    await this.persistLinks();
    return this.workspace(policy.workspaceId);
  }
  async setPeers(id: string, peers: string[]) {
    const node = await this.workspace(id);
    node.link.peers = [...new Set(peers.map((p) => p.trim()).filter(Boolean))];
    await this.persistLinks();
  }
  async revoke(id: string, deviceId: string) {
    const node = await this.workspace(id),
      access = await revokeMember(
        node.replica.access,
        this.identity,
        deviceId,
        node.replica
          .entries()
          .filter(
            (c) =>
              c.author === deviceId ||
              currentPolicy(node.replica.access).members[c.author]
                ?.delegatedBy === deviceId,
          )
          .map((c) => c.hash),
      );
    await node.replica.setPolicies(access.policies);
    await this.persistLinks();
  }
  attachTransport(transport: PeerTransport) {
    this.transport = transport;
    for (const node of this.workspaces.values())
      node.sync = new PeerSync(node.protocol, transport);
  }
  async closeWorkspace(id: string) {
    const node = this.workspaces.get(id);
    this.protocols.delete(id);
    if (node) {
      await node.stop();
      this.workspaces.delete(id);
    }
    await this.storage.closeWorkspace?.(id);
  }
  async deleteWorkspace(id: string) {
    await this.closeWorkspace(id);
    await deleteWorkspaceData(this.storage, id);
    this.links = this.links.filter((link) => link.id !== id);
    await this.persistLinks();
  }
  async close() {
    for (const node of this.workspaces.values()) await node.replica.flush();
    await this.transport?.close();
    await this.storage.close?.();
  }
}
