import type { DurableStorage } from "./index";
import { canonical, digest, utf8, text } from "../core/crypto";
import { invariant } from "@taskasaur/platform/core/errors";
import type { LinkedWorkspace } from "../core/device";
import type { Identity } from "../core/crypto";

export interface WorkspaceManifest {
  format: "taskasaur-workspace-v1";
  packageId: string;
  revision: number;
  history: "signed-automerge-changes-v1";
  workspace: LinkedWorkspace;
  entries: Record<string, { hash: string; size: number }>;
  connectionCredential?: Identity;
}
export interface WorkspaceFiles {
  read(path: string): Promise<Uint8Array | undefined>;
  /** Atomically replace a file; resolve only after its durable commit. */
  write(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** Optional atomic package commit for a single-file container. */
  commit?(
    manifest: Uint8Array,
    additions: Record<string, Uint8Array>,
  ): Promise<void>;
  refresh?(): Promise<void>;
  close?(): Promise<void>;
}
export const sharedWorkspaceKey = (workspaceId: string, key: string) =>
  key === `workspace/${workspaceId}/access` ||
  key === `workspace/${workspaceId}/delegations` ||
  new RegExp(`^workspace/${workspaceId}/(?:changes|blobs)/[a-f0-9]{64}$`).test(
    key,
  );
export function parseWorkspaceManifest(bytes: Uint8Array): WorkspaceManifest {
  invariant(
    bytes.length <= 64 * 1024 * 1024,
    "INVALID_WORKSPACE",
    "Workspace manifest exceeds 64 MB",
  );
  const value = JSON.parse(text.decode(bytes)) as WorkspaceManifest;
  invariant(
    value &&
      value.format === "taskasaur-workspace-v1" &&
      value.history === "signed-automerge-changes-v1" &&
      /^[0-9a-f-]{36}$/.test(value.packageId) &&
      /^[0-9a-f-]{36}$/.test(value.workspace?.id) &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      typeof value.workspace.name === "string" &&
      Array.isArray(value.workspace.policies) &&
      Array.isArray(value.workspace.peers) &&
      value.workspace.peers.every(
        (p) => typeof p === "string" && p.length <= 4096,
      ) &&
      value.entries &&
      typeof value.entries === "object" &&
      !Array.isArray(value.entries) &&
      Object.keys(value.entries).length <= 1000000,
    "INVALID_WORKSPACE",
    "Invalid workspace package",
  );
  for (const [key, entry] of Object.entries(value.entries))
    invariant(
      entry &&
        sharedWorkspaceKey(value.workspace.id, key) &&
        /^[a-f0-9]{64}$/.test(entry.hash) &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        entry.size <= 40 * 1024 * 1024,
      "INVALID_WORKSPACE",
      "Invalid workspace entry",
    );
  return value;
}
/** Content-addressed encrypted data plus an atomic manifest. No device identities or caches. */
export class WorkspaceStorage implements DurableStorage {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    readonly files: WorkspaceFiles,
    public manifest: WorkspaceManifest,
  ) {}
  static async open(files: WorkspaceFiles) {
    const bytes = await files.read("workspace.json");
    invariant(
      bytes,
      "INVALID_WORKSPACE",
      "Select a Taskasaur workspace file or folder",
    );
    return new WorkspaceStorage(files, parseWorkspaceManifest(bytes));
  }
  static async create(
    files: WorkspaceFiles,
    workspace: LinkedWorkspace,
    entries: Record<string, Uint8Array>,
    connectionCredential?: Identity,
  ) {
    invariant(
      !(await files.read("workspace.json")),
      "WORKSPACE_EXISTS",
      "Choose a new workspace file or folder",
    );
    const manifest: WorkspaceManifest = {
      format: "taskasaur-workspace-v1",
      packageId: crypto.randomUUID(),
      revision: 0,
      history: "signed-automerge-changes-v1",
      workspace: structuredClone(workspace),
      entries: {},
      ...(connectionCredential ? { connectionCredential } : {}),
    };
    const additions: Record<string, Uint8Array> = {};
    for (const [key, bytes] of Object.entries(entries)) {
      if (!sharedWorkspaceKey(workspace.id, key)) continue;
      const hash = await digest(bytes);
      additions[`data/${hash}.bin`] = bytes;
      manifest.entries[key] = { hash, size: bytes.length };
    }
    // Publish only after all referenced bytes are durable.
    const metadata = utf8.encode(canonical(manifest));
    if (files.commit) await files.commit(metadata, additions);
    else {
      for (const [name, bytes] of Object.entries(additions))
        await files.write(name, bytes);
      await files.write("workspace.json", metadata);
    }
    return new WorkspaceStorage(files, manifest);
  }
  /** Re-read an unopened/import source after approval may have updated its package. */
  refresh() {
    return this.serial(async () => {
      await this.files.refresh?.();
      const bytes = await this.files.read("workspace.json");
      invariant(bytes, "INVALID_WORKSPACE", "Workspace manifest is missing");
      const current = parseWorkspaceManifest(bytes);
      invariant(
        current.packageId === this.manifest.packageId &&
          current.workspace.id === this.manifest.workspace.id,
        "WORKSPACE_CHANGED",
        "The selected location was replaced by another workspace",
      );
      this.manifest = current;
    });
  }
  private serial<T>(work: () => Promise<T>) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  private async commit(
    next: WorkspaceManifest,
    additions: Record<string, Uint8Array> = {},
  ) {
    const disk = await this.files.read("workspace.json");
    invariant(
      disk &&
        canonical(parseWorkspaceManifest(disk)) === canonical(this.manifest),
      "WORKSPACE_CHANGED",
      "The workspace changed outside this session. Close and reopen it before writing.",
    );
    next.revision++;
    const metadata = utf8.encode(canonical(next));
    if (this.files.commit) await this.files.commit(metadata, additions);
    else {
      for (const [name, bytes] of Object.entries(additions))
        await this.files.write(name, bytes);
      await this.files.write("workspace.json", metadata);
    }
    this.manifest = next;
  }
  private async release(hash?: string) {
    if (
      hash &&
      !Object.values(this.manifest.entries).some((entry) => entry.hash === hash)
    )
      await this.files.remove(`data/${hash}.bin`);
  }
  async get(key: string) {
    const entry = this.manifest.entries[key];
    if (!entry) return;
    const bytes = await this.files.read(`data/${entry.hash}.bin`);
    invariant(
      bytes &&
        bytes.length === entry.size &&
        (await digest(bytes)) === entry.hash,
      "INTEGRITY_FAILED",
      "Workspace content is missing or corrupt",
    );
    return bytes;
  }
  set(key: string, bytes: Uint8Array) {
    invariant(
      sharedWorkspaceKey(this.manifest.workspace.id, key),
      "LOCAL_STATE",
      "Device state cannot be written into a workspace package",
    );
    const copy = bytes.slice();
    return this.serial(async () => {
      const hash = await digest(copy);
      const previous = this.manifest.entries[key]?.hash;
      if (this.manifest.entries[key]?.hash === hash) return;
      const next = structuredClone(this.manifest);
      next.entries[key] = { hash, size: copy.length };
      if (key.endsWith("/access"))
        next.workspace.policies = JSON.parse(text.decode(copy));
      if (key.endsWith("/delegations"))
        next.workspace.delegations = JSON.parse(text.decode(copy));
      await this.commit(next, { [`data/${hash}.bin`]: copy });
      await this.release(previous);
    });
  }
  delete(key: string) {
    return this.serial(async () => {
      if (!this.manifest.entries[key]) return;
      const previous = this.manifest.entries[key].hash;
      const next = structuredClone(this.manifest);
      delete next.entries[key];
      await this.commit(next);
      await this.release(previous);
    });
  }
  updateWorkspace(workspace: LinkedWorkspace) {
    workspace = structuredClone(workspace);
    return this.serial(async () => {
      invariant(
        workspace.id === this.manifest.workspace.id,
        "WORKSPACE_MISMATCH",
        "Wrong workspace",
      );
      if (canonical(workspace) === canonical(this.manifest.workspace)) return;
      const next = structuredClone(this.manifest);
      next.workspace = structuredClone({
        ...workspace,
        peers: workspace.peers.filter(
          (address) => !address.startsWith("local:"),
        ),
      });
      await this.commit(next);
    });
  }
  async keys(prefix: string) {
    return Object.keys(this.manifest.entries)
      .filter((k) => k.startsWith(prefix))
      .sort();
  }
  snapshot(prefix = "") {
    return this.serial(async () => {
      const result: Record<string, Uint8Array> = {};
      for (const key of await this.keys(prefix))
        result[key] = (await this.get(key))!;
      return result;
    });
  }
  async close() {
    await this.queue;
    await this.files.close?.();
  }
}
/** Local device state stays in its normal adapter while shared writes go to the selected package. */
export class WorkspaceRouter implements DurableStorage {
  readonly mounts = new Map<string, WorkspaceStorage>();
  readonly blocked = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly local: DurableStorage) {}
  private serial<T>(work: () => Promise<T>) {
    const next = this.queue.then(work);
    this.queue = next.catch(() => {});
    return next;
  }
  mount(
    target: WorkspaceStorage,
    copyCurrent = true,
    excludedKeys: string[] = [],
  ) {
    return this.serial(async () => {
      const id = target.manifest.workspace.id;
      const excluded = new Set(excludedKeys);
      for (const key of excluded) await target.delete(key);
      if (copyCurrent)
        for (const key of await this.keys(`workspace/${id}/`)) {
          if (!sharedWorkspaceKey(id, key) || excluded.has(key)) continue;
          const bytes = await this.get(key);
          if (bytes) await target.set(key, bytes);
        }
      if (copyCurrent) {
        const links = await this.local.get("device/workspaces");
        const current =
          links &&
          (JSON.parse(text.decode(links)) as LinkedWorkspace[]).find(
            (link) => link.id === id,
          );
        if (current) await target.updateWorkspace(current);
      }
      const old = this.mounts.get(id);
      this.mounts.set(id, target);
      this.blocked.delete(id);
      if (old && old !== target) await old.close();
    });
  }
  private target(key: string) {
    const id = key.split("/")[1],
      mount = this.mounts.get(id);
    invariant(
      !this.blocked.has(id) || !sharedWorkspaceKey(id, key),
      "FOLDER_PERMISSION",
      "Reconnect this workspace file or folder from the welcome screen before opening it.",
    );
    return mount && sharedWorkspaceKey(id, key) ? mount : this.local;
  }
  get(key: string) {
    return this.target(key).get(key);
  }
  set(key: string, bytes: Uint8Array) {
    bytes = bytes.slice();
    return this.serial(async () => {
      if (key === "device/workspaces") {
        const links = JSON.parse(text.decode(bytes)) as LinkedWorkspace[];
        for (const link of links)
          await this.mounts.get(link.id)?.updateWorkspace(link);
      }
      await this.target(key).set(key, bytes);
    });
  }
  delete(key: string) {
    return this.serial(() => this.target(key).delete(key));
  }
  async keys(prefix: string) {
    const keys = (await this.local.keys(prefix)).filter(
      (k) => this.target(k) === this.local,
    );
    for (const mount of this.mounts.values())
      keys.push(...(await mount.keys(prefix)));
    return [...new Set(keys)].sort();
  }
  snapshot(prefix = "") {
    return this.serial(async () => {
      const entries: Record<string, Uint8Array> = {};
      for (const key of await this.keys(prefix)) {
        const bytes = await this.get(key);
        if (bytes) entries[key] = bytes;
      }
      return entries;
    });
  }
  async close() {
    await this.queue;
    for (const mount of this.mounts.values()) await mount.close();
    await this.local.close?.();
  }
  async closeWorkspace(id: string) {
    await this.queue;
    const mount = this.mounts.get(id);
    if (mount) {
      await mount.close();
      this.mounts.delete(id);
      this.blocked.add(id);
    }
    await this.local.closeWorkspace?.(id);
  }
}
