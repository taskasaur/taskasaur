import {
  decodeWorkspaceArchive,
  encodeWorkspaceArchive,
} from "../storage/workspace-archive";
import { MemoryStorage } from "../storage";
import {
  WorkspaceStorage,
  type WorkspaceFiles,
  sharedWorkspaceKey,
} from "../storage/workspace";
import { Replica } from "./replica";
import { ReplicaFiles } from "./files";
import { StoragePlacement, type StorageCatalog } from "./storage-placement";
import type { DeviceCore, WorkspaceNode, LinkedWorkspace } from "./device";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { acceptPolicies, validatePolicy } from "./identity";
import { canonical, utf8 } from "./crypto";
import { invariant } from "@taskasaur/platform/core/errors";

export class MemoryWorkspaceFiles implements WorkspaceFiles {
  readonly values = new Map<string, Uint8Array>();
  async read(path: string) {
    return this.values.get(path)?.slice();
  }
  async write(path: string, bytes: Uint8Array) {
    this.values.set(path, bytes.slice());
  }
  async remove(path: string) {
    this.values.delete(path);
  }
}
export async function validateWorkspaceHistory(workspace: LinkedWorkspace) {
  invariant(
    workspace.policies.length > 0 && workspace.policies.length <= 10000,
    "INVALID_WORKSPACE",
    "Workspace membership history is missing",
  );
  for (let i = 0; i < workspace.policies.length; i++) {
    await validatePolicy(workspace.policies[i], workspace.policies[i - 1]);
    invariant(
      workspace.policies[i].workspaceId === workspace.id,
      "WORKSPACE_MISMATCH",
      "Workspace history belongs to another workspace",
    );
  }
}
async function verifySnapshot(
  node: Pick<WorkspaceNode, "replica">,
  entries: Record<string, Uint8Array>,
) {
  const memory = new MemoryStorage();
  for (const [key, bytes] of Object.entries(entries))
    if (sharedWorkspaceKey(node.replica.workspaceId, key))
      await memory.set(key, bytes);
  const replica = await new Replica(
    node.replica.identity,
    node.replica.access,
    memory,
  ).open();
  invariant(
    !replica.status().pending && !replica.status().quarantined,
    "INCOMPLETE_WORKSPACE",
    "Workspace history is incomplete or invalid",
  );
  const localSettings = new Set(
    replica
      .ids("record/")
      .filter((id) => {
        const row = replica.read<ResourceRecord>(id)!;
        return row.collection === "settings" && row.data.scope === "device";
      })
      .map((id) => id.slice(7)),
  );
  if (localSettings.size) {
    // Old versions replicated these incorrectly. Preserve shared histories while leaving device settings behind.
    for (const change of replica.entries()) {
      const value = replica.read<Record<string, unknown>>(change.documentId);
      const item = value?.item as { kind?: string; id?: string } | undefined;
      if (
        (change.documentId.startsWith("record/") &&
          localSettings.has(change.documentId.slice(7))) ||
        (change.documentId.startsWith("setting/storage.catalog.") &&
          localSettings.has(String(value?.id))) ||
        (change.documentId.startsWith("setting/storage.") &&
          item?.kind === "record" &&
          localSettings.has(String(item.id))) ||
        (change.documentId.startsWith("event/") &&
          localSettings.has(String(value?.subject)))
      )
        await memory.delete(
          `workspace/${replica.workspaceId}/changes/${change.hash}`,
        );
    }
    return verifySnapshot(node, await memory.snapshot());
  }
  const files = new ReplicaFiles(replica),
    placement = new StoragePlacement(replica, files);
  for (const id of replica.ids("record/")) {
    const row = replica.read<ResourceRecord>(id)!;
    if (row.collection === "files" && !row.deletedAt && !row.data.is_folder)
      invariant(
        files
          .manifests()
          .some(
            (version) =>
              version.fileId === row.id &&
              (!row.data.version_id || version.id === row.data.version_id),
          ),
        "INCOMPLETE_WORKSPACE",
        "A file upload or download is incomplete. Finish saving all files before exporting.",
      );
  }
  const missing = (await placement.list()).filter(
    (item) => !item.deleted && !item.local,
  );
  invariant(
    !missing.length,
    "INCOMPLETE_WORKSPACE",
    `Download all workspace copies before exporting. ${missing.length} records or file versions are unavailable on this device.`,
  );
  for (const id of replica.ids("setting/storage.catalog.")) {
    const catalog = replica.read<StorageCatalog>(id)!;
    const state = await placement.status({ kind: "record", id: catalog.id });
    invariant(
      state.deleted || replica.hasHeads("record/" + catalog.id, catalog.heads),
      "INCOMPLETE_WORKSPACE",
      "A newer known record version is still on another device. Download it before exporting.",
    );
  }
  // Read every live version, verifying its full checksum rather than only its manifest.
  for (const item of await placement.list())
    if (item.item.kind === "file-version" && !item.deleted)
      await files.read(item.item.id);
  return memory.snapshot();
}
export async function workspaceSnapshot(node: WorkspaceNode) {
  await node.replica.flush();
  invariant(
    node.replica.storage.snapshot,
    "SNAPSHOT_UNAVAILABLE",
    "Consistent workspace snapshots are unavailable",
  );
  const raw = await node.replica.storage.snapshot(
    `workspace/${node.replica.workspaceId}/`,
  );
  const entries = await verifySnapshot(node, raw);
  const excludedKeys = Object.keys(raw).filter(
    (key) => sharedWorkspaceKey(node.replica.workspaceId, key) && !entries[key],
  );
  const workspace = structuredClone({
    ...node.link,
    policies: node.replica.access.policies,
  });
  return { workspace, entries, excludedKeys };
}
export async function exportWorkspace(node: WorkspaceNode) {
  const { workspace, entries } = await workspaceSnapshot(node);
  const files = new MemoryWorkspaceFiles();
  await WorkspaceStorage.create(files, workspace, entries);
  return encodeWorkspaceArchive(files.values);
}
export async function openWorkspaceArchive(bytes: Uint8Array) {
  const values = await decodeWorkspaceArchive(bytes);
  const files = new MemoryWorkspaceFiles();
  for (const [name, data] of values) await files.write(name, data);
  const source = await WorkspaceStorage.open(files);
  await validateWorkspaceHistory(source.manifest.workspace);
  return source;
}
export async function importWorkspace(
  device: DeviceCore,
  source: WorkspaceStorage,
  invitation?: string,
) {
  await source.refresh();
  const workspace = source.manifest.workspace;
  await validateWorkspaceHistory(workspace);
  let policies = workspace.policies,
    peers = workspace.peers;
  const existing = device.profiles().find((p) => p.id === workspace.id);
  if (existing && existing.policies.length > policies.length)
    policies = existing.policies;
  if (invitation) {
    const approved = JSON.parse(invitation);
    invariant(
      approved.format === "taskasaur-pairing-v1" &&
        approved.policies?.at(-1)?.workspaceId === workspace.id,
      "WORKSPACE_MISMATCH",
      "Approval must be for this workspace and this device",
    );
    if (approved.policies.length >= policies.length)
      policies = approved.policies;
    peers = [...new Set([...peers, ...approved.peers])];
  }
  for (let i = 0; i < workspace.policies.length; i++)
    invariant(
      canonical(policies[i]) === canonical(workspace.policies[i]),
      "POLICY_FORK",
      "The approval and workspace file have different membership histories",
    );
  invariant(
    policies.at(-1)?.members[device.identity.id],
    "APPROVAL_REQUIRED",
    "Approve this device on the workspace owner's computer, then paste its invitation",
  );
  const access = await acceptPolicies(device.identity, policies);
  const staging = new MemoryStorage();
  for (const [key, bytes] of Object.entries(await source.snapshot()))
    await staging.set(key, bytes);
  await staging.set(
    `workspace/${workspace.id}/access`,
    utf8.encode(canonical(policies)),
  );
  let replica = await new Replica(device.identity, access, staging).open();
  invariant(
    !replica.status().pending && !replica.status().quarantined,
    "INVALID_WORKSPACE",
    "Workspace history failed signature or dependency validation",
  );
  const verified = await verifySnapshot({ replica }, await staging.snapshot());
  for (const key of await staging.keys(""))
    if (!verified[key]) await staging.delete(key);
  replica = await new Replica(device.identity, access, staging).open();
  const node = await device.join(
    JSON.stringify({ format: "taskasaur-pairing-v1", policies, peers }),
  );
  // Keep the original authors and Automerge change hashes: later peer sync merges the same history.
  for (const change of replica.entries()) await node.replica.accept(change);
  const stagedFiles = new ReplicaFiles(replica);
  for (const hash of new Set(
    stagedFiles.manifests().flatMap((m) => m.chunks),
  )) {
    const bytes = await stagedFiles.getChunk(hash);
    if (bytes) await node.protocol.files.putChunk(hash, bytes);
  }
  await device.setPeers(workspace.id, [
    ...new Set([...node.link.peers, ...peers]),
  ]);
  for (const key of await source.keys(""))
    if (!verified[key]) await source.delete(key);
  return node;
}
