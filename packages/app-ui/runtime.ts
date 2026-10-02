import { defaultServerUrl, serverFetch } from "./network";
import Dexie, { type Table } from "dexie";
import { LocalDatabase } from "../data-dexie";
import { PluginRegistry } from "@taskasaur/platform/core/registry";
import {
  getSchema,
  manifestById,
  registerExtension,
} from "@taskasaur/platform/core/catalog";
import { CoreError, invariant } from "@taskasaur/platform/core/errors";
import type {
  Principal,
  ResourceRecord,
  Mutation,
  PluginEvent,
} from "@taskasaur/platform/plugin-sdk";
import { SyncEngine } from "../sync-supabase";
import { SyncQueue } from "../sync-supabase/queue";
import type { PluginState } from "@taskasaur/platform/core/registry";
import {
  createBrowserPluginHost,
  type ExtensionContract,
  type Surface,
} from "./plugin-host";
import type { PluginHost } from "@taskasaur/platform/core/host";

export interface WorkspaceProfile {
  id: string;
  userId: string;
  workspaceId: string;
  name: string;
  serverUrl: string;
  connected: boolean;
}
class Bootstrap extends Dexie {
  profiles!: Table<WorkspaceProfile, string>;
  constructor() {
    super("taskasaur-bootstrap-v2");
    this.version(1).stores({ profiles: "id" });
  }
}
export class AppRuntime {
  readonly db: LocalDatabase;
  readonly registry: PluginRegistry;
  readonly principal: Principal;
  readonly sync: SyncEngine;
  private syncQueue = new SyncQueue();
  readonly surfaces = new Map<string, Surface>();
  readonly surfaceListeners = new Set<() => void>();
  surfacesVersion = 0;
  private host?: PluginHost;
  private hostState = "";
  private extensions: ExtensionContract[] = [];
  notifySurfaces() {
    this.surfacesVersion++;
    for (const listener of this.surfaceListeners) listener();
  }
  private async refreshHost() {
    const key = JSON.stringify(
      [...this.registry.states.values()].map((s) => [
        s.id,
        s.version,
        s.enabled,
        s.features,
      ]),
    );
    if (this.host && key === this.hostState) return;
    await this.host?.close();
    this.surfaces.clear();
    this.notifySurfaces();
    this.host = await createBrowserPluginHost(this, this.extensions);
    this.hostState = key;
  }
  constructor(public readonly profile: WorkspaceProfile) {
    this.db = new LocalDatabase(profile.workspaceId, profile.userId);
    this.registry = new PluginRegistry(this.db.pluginPersistence());
    this.principal = {
      userId: profile.userId,
      workspaceId: profile.workspaceId,
      pluginId: "records",
      permissions: [],
    };
    this.sync = new SyncEngine(this.db, {
      push: (m) => this.push(m),
      pull: (cursor) => this.api(`sync?cursor=${encodeURIComponent(cursor)}`),
    });
  }
  async initialize() {
    let extensions =
      (await this.db.getMetadata<ExtensionContract[]>("core.extensions")) ?? [];
    if (this.profile.connected && navigator.onLine) {
      try {
        extensions = await this.api("plugins/packages");
        await this.db.setMetadata("core.extensions", extensions);
      } catch (error) {
        if (!extensions.length && !(error instanceof TypeError)) throw error;
      }
    }
    for (const extension of extensions) {
      const { manifest } = registerExtension(
        extension.manifest,
        extension.schemas,
      );
      this.registry.manifests.set(manifest.id, manifest);
    }
    await this.registry.initialize();
    this.extensions = extensions;
    await this.refreshHost();
    return this;
  }
  collection(id: string) {
    const schema = getSchema(id);
    return this.db
      .scoped(
        { ...this.principal, pluginId: schema.pluginId },
        schema.pluginId,
        this.profile.connected ? "synced" : "local-only",
      )
      .collection(id);
  }
  async api<T = unknown>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    invariant(
      this.profile.connected,
      "ONLINE_REQUIRED",
      "Connect a workspace to use this server feature",
    );
    const url = new URL(
      `/api/${path}`,
      this.profile.serverUrl || defaultServerUrl(),
    );
    url.searchParams.set("workspaceId", this.profile.workspaceId);
    const response = await serverFetch(url, {
      method,
      credentials: "include",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json();
    if (!response.ok || payload.error)
      throw new CoreError(
        payload.error?.data?.kind ?? payload.error?.kind ?? "NETWORK_ERROR",
        payload.error?.message ?? "Server request failed",
      );
    return payload as T;
  }
  async push(mutation: Mutation): Promise<ResourceRecord> {
    const {
      id,
      resourceId,
      pluginId,
      collection,
      operation,
      baseRevision,
      data,
      createdAt,
    } = mutation;
    const response = await this.api<{
      result?: ResourceRecord;
      error?: { message: string; data: { kind: string } };
    }>("rpc", {
      context: {
        workspaceId: this.profile.workspaceId,
        pluginId: mutation.pluginId,
      },
      request: {
        jsonrpc: "2.0",
        id: mutation.id,
        method: `${mutation.collection}.${mutation.operation}`,
        params: {
          id,
          resourceId,
          pluginId,
          collection,
          operation,
          baseRevision,
          data,
          createdAt,
        },
      },
    });
    if (response.error)
      throw new CoreError(response.error.data.kind, response.error.message);
    invariant(
      response.result,
      "INVALID_RESPONSE",
      "Server returned no mutation result",
    );
    return response.result;
  }
  async pluginAction(
    id: string,
    action: "install" | "enable" | "disable" | "uninstall",
  ) {
    if (this.profile.connected) await this.api("plugins", { id, action });
    const result = await this.registry[action](id);
    await this.refreshHost();
    if (action === "disable" || action === "uninstall")
      await this.db.metadata.put({
        key: `plugin.${id}.disabledAt`,
        value: new Date().toISOString(),
      });
    return result;
  }
  async installAndEnable(id: string) {
    for (const dep of manifestById.get(id)?.dependencies ?? [])
      if (!this.registry.enabled(dep)) await this.installAndEnable(dep);
    await this.pluginAction(id, "install");
    await this.pluginAction(id, "enable");
  }
  async configurePlugin(id: string, features: string[]) {
    if (this.profile.connected)
      await this.api("plugins/features", { id, features });
    await this.registry.configure(id, features);
    await this.refreshHost();
  }
  async synchronize() {
    if (!this.profile.connected || !navigator.onLine) return;
    const work = async () => {
      const inventory =
        await this.api<Array<{ state: PluginState }>>("plugins");
      for (const { state } of inventory) {
        const previous = this.registry.states.get(state.id);
        if (
          previous?.error &&
          previous.version === state.version &&
          previous.enabled === state.enabled &&
          JSON.stringify(previous.features) === JSON.stringify(state.features)
        )
          state.error = previous.error;
        this.registry.states.set(state.id, state);
        await this.db.plugins.put(state);
      }
      await this.refreshHost();
      await this.sync.synchronize();
      for (let page = 0; page < 10; page++) {
        const cursor =
          (await this.db.getMetadata<string>("events.cursor")) ?? "0";
        const batch = await this.api<{
          events: PluginEvent[];
          cursor: string;
          hasMore: boolean;
        }>(`events?cursor=${cursor}`);
        for (const event of batch.events) await this.host?.deliver(event);
        await this.db.setMetadata("events.cursor", batch.cursor);
        if (!batch.hasMore) break;
      }
      const versions = (
        await this.db.fileVersions.orderBy("createdAt").toArray()
      ).filter((v) => !v.synced && !v.error && !v.recoveryFileId);
      const blocked = new Set<string>();
      for (const version of versions) {
        if (blocked.has(version.fileId)) continue;
        const file = await this.db.records.get(version.fileId);
        if (
          !file ||
          file.deletedAt ||
          file.revision === 0 ||
          (await this.db.outbox.where("resourceId").equals(file.id).count())
        )
          continue;
        try {
          const url = new URL(
            "/api/files",
            this.profile.serverUrl || defaultServerUrl(),
          );
          url.searchParams.set("workspaceId", this.profile.workspaceId);
          url.searchParams.set("id", version.fileId);
          url.searchParams.set("version", version.id);
          if (version.parentVersionId)
            url.searchParams.set("parent", version.parentVersionId);
          const response = await serverFetch(url, {
            method: "PUT",
            credentials: "include",
            headers: {
              "Content-Type": version.blob.type || "application/octet-stream",
            },
            body: version.blob,
          });
          const result = await response.json();
          if (!response.ok)
            throw new CoreError(
              result.error?.kind ?? "UPLOAD_FAILED",
              result.error?.message ?? "File upload failed",
            );
          await this.db.acknowledgeFile(version.id, result.record);
        } catch (error) {
          if (
            error instanceof CoreError &&
            [
              "REVISION_CONFLICT",
              "PERMISSION_DENIED",
              "IDEMPOTENCY_CONFLICT",
            ].includes(error.kind)
          ) {
            await this.db.fileVersions.update(version.id, {
              error: error.message,
            });
            blocked.add(version.fileId);
          } else throw error;
        }
      }
      const devices = await this.api<ResourceRecord[]>("devices");
      await this.db.ingest(
        devices,
        (await this.db.getMetadata<string>("sync.cursor")) ?? "0",
      );
    };
    return this.syncQueue.run(work);
  }
  async fileBytes(fileId: string) {
    const file = await this.db.records.get(fileId);
    invariant(
      file?.collection === "files" && file.data.version_id,
      "NOT_FOUND",
      "File has no saved version",
    );
    const id = String(file.data.version_id),
      local = await this.db.fileVersions.get(id);
    if (local) return local;
    invariant(
      this.profile.connected && navigator.onLine,
      "OFFLINE_UNAVAILABLE",
      "Download this file before opening it offline",
    );
    const url = new URL(
      "/api/files",
      this.profile.serverUrl || defaultServerUrl(),
    );
    url.searchParams.set("workspaceId", this.profile.workspaceId);
    url.searchParams.set("id", fileId);
    url.searchParams.set("version", id);
    const response = await serverFetch(url, { credentials: "include" });
    invariant(response.ok, "DOWNLOAD_FAILED", "File download failed");
    const value = {
      id,
      fileId,
      parentVersionId: null,
      blob: await response.blob(),
      createdAt: new Date().toISOString(),
      synced: true,
    };
    await this.db.fileVersions.put(value);
    return value;
  }
  async close() {
    await this.host?.close();
    this.surfaces.clear();
    this.notifySurfaces();
    this.db.close();
  }
}
export async function profiles() {
  const db = new Bootstrap();
  try {
    return await db.profiles.toArray();
  } finally {
    db.close();
  }
}
export async function saveProfile(profile: WorkspaceProfile) {
  const db = new Bootstrap();
  try {
    await db.profiles.put(profile);
  } finally {
    db.close();
  }
}
export async function createLocalWorkspace(name: string) {
  const profile: WorkspaceProfile = {
    id: crypto.randomUUID(),
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    name,
    serverUrl: "",
    connected: false,
  };
  await saveProfile(profile);
  return profile;
}
