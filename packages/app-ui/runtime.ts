import {
  bindingFor,
  slotFor,
  configureExecution,
  inspectExecution,
  executionRecord,
  executionRequirements,
  executionReady,
  executionActive,
  requireExecution,
} from "../core/execution";
import { releaseService } from "../core/services";
import type {
  ExecutionSlot,
  DevicePluginStatus,
} from "@taskasaur/platform/plugin-sdk/execution";
import {
  defaultInventoryUrl,
  readInventory,
  boundedDownload,
  type PluginInventory,
  type InventoryEntry,
} from "@taskasaur/platform/plugin-sdk/inventory";
import {
  verifyArtifact,
  artifactHash,
} from "@taskasaur/platform/plugin-sdk/artifact";
import { isRequiredCore } from "@taskasaur/platform/core/catalog";
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
import { browserDevice, activateWorkspace } from "../platform-browser/device";
import type { DeviceCore, WorkspaceNode } from "../core/device";
import { deviceRecordId } from "../core/records";
import { ensureCollectionTables, scopedTableStore } from "./collection-tables";
import { WorkspaceSearch } from "./search-index";
import type {
  PluginCommand,
  SearchCollectionOptions,
} from "@taskasaur/platform/plugin-sdk/navigation";
import { currentPolicy, delegateDevice } from "../core/identity";
import { workflowTriggers, reminders, operationId } from "../core/schedules";
import { PortableWorkflows } from "../core/workflows";
import { runBrowserTypeScript } from "../platform-browser/typescript";
import type { FileManifest } from "../core/files";
import { SyncQueue } from "../sync/queue";
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
  storage?: "internal" | "file";
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
  device!: DeviceCore;
  node!: WorkspaceNode;
  automation!: PortableWorkflows;
  automationOptions = { enabled: false, trustedCode: false };
  allowRemotePlugins = false;
  private projectionQueue: Promise<unknown> = Promise.resolve();
  private projectionListener?: (id: string) => void;
  private syncQueue = new SyncQueue();
  readonly surfaces = new Map<string, Surface>();
  readonly commands = new Map<string, PluginCommand & { pluginId: string }>();
  readonly searchOptions = new Map<string, SearchCollectionOptions>();
  readonly search = new WorkspaceSearch(this);
  navigate: (
    pluginId: string,
    page?: string,
    recordId?: string,
  ) => void | Promise<void> = () => {};
  readonly surfaceListeners = new Set<() => void>();
  surfacesVersion = 0;
  private host?: PluginHost;
  private hostState = "";
  private extensions: ExtensionContract[] = [];
  installedPackage(id: string) {
    return this.extensions.find((extension) => extension.manifest.id === id);
  }
  availablePlugins: InventoryEntry[] = [];
  inventoryError = "";
  private inventory?: PluginInventory;
  private closed = false;
  assertActive() {
    invariant(!this.closed, "WORKSPACE_CLOSED", "This workspace is closed");
  }
  async refreshInventory() {
    try {
      const inventory = await readInventory(
        import.meta.env.VITE_PLUGIN_INVENTORY_URL || defaultInventoryUrl,
        { allowHttp: import.meta.env.DEV, followRedirects: true },
      );
      if (this.closed) return;
      this.inventory = inventory;
      this.availablePlugins = inventory.plugins;
      this.inventoryError = "";
      await this.db.setMetadata("core.inventory", inventory);
    } catch (error) {
      this.inventoryError =
        error instanceof Error ? error.message : "Plugin inventory unavailable";
    }
    this.notifySurfaces();
  }
  private registerPackages(extensions: ExtensionContract[]) {
    for (const extension of extensions) {
      const { manifest } = registerExtension(
        extension.manifest,
        extension.schemas,
      );
      this.registry.manifests.set(manifest.id, manifest);
    }
    this.extensions = extensions;
  }
  private async ensurePackage(id: string, reviewedDigest?: string) {
    if (isRequiredCore(id)) return;
    const existing = this.extensions.find((e) => e.manifest.id === id);
    const entry = this.availablePlugins.find((p) => p.id === id);
    if (reviewedDigest)
      invariant(
        (entry?.sha256 ?? existing?.digest) === reviewedDigest,
        "INVENTORY_CHANGED",
        "The release changed; review it again",
      );
    if (
      existing &&
      (!entry || existing.digest === entry.sha256) &&
      (!existing.manifest.entrypoints.browser ||
        (await this.db.getMetadata(`extension.source.${existing.digest}`))) &&
      (!existing.manifest.entrypoints.core ||
        (await this.db.getMetadata(`extension.core.${existing.digest}`)))
    )
      return;
    invariant(
      entry && this.inventory,
      "PLUGIN_NOT_FOUND",
      "Refresh the inventory to find this plugin",
    );
    const bytes = await boundedDownload(entry.downloadUrl, 50 * 1024 * 1024, {
      allowHttp: import.meta.env.DEV,
      followRedirects: true,
    });
    const verified = await verifyArtifact(
      bytes,
      this.inventory.publishers,
      entry,
    );
    const browser = verified.manifest.entrypoints.browser,
      core = verified.manifest.entrypoints.core;
    const extension: ExtensionContract = {
      manifest: verified.manifest,
      schemas: verified.contracts,
      grants: entry.grants,
      digest: verified.digest,
      coreDigest: core ? await artifactHash(verified.files[core]) : undefined,
      browserDigest: browser
        ? await artifactHash(verified.files[browser])
        : undefined,
    };
    if (core)
      await this.db.setMetadata(
        `extension.core.${extension.digest}`,
        new TextDecoder().decode(verified.files[core]),
      );
    if (browser)
      await this.db.setMetadata(
        `extension.source.${extension.digest}`,
        new TextDecoder().decode(verified.files[browser]),
      );
    this.registerPackages([
      ...this.extensions.filter((e) => e.manifest.id !== id),
      extension,
    ]);
    await this.db.setMetadata("core.extensions", this.extensions);
  }
  async callPluginCommand(pluginId: string, command: string, input: unknown) {
    const manifest = this.registry.manifests.get(pluginId),
      extension = this.extensions.find((e) => e.manifest.id === pluginId);
    invariant(
      manifest && this.registry.enabled(pluginId),
      "FEATURE_DISABLED",
      "Plugin is disabled",
    );
    invariant(
      manifest.provides.commands.includes(command) ||
        (manifest.consumes.commands.includes(command) &&
          extension?.grants.includes(command)),
      "UNDECLARED_COMMAND",
      "Declare and grant this command",
    );
    invariant(this.host, "PLUGIN_UNAVAILABLE", "Plugin host is unavailable");
    const principal = {
      ...this.principal,
      pluginId,
      permissions: [
        ...manifest.permissions,
        this.host.router.permissionFor(command) ?? command,
      ],
    };
    const request = {
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method: command,
      params: input,
    };
    const response =
      this.host.router.has(command) &&
      !executionRecord(this.node, command, input)
        ? await this.host.router.receive(request, {
            principal,
            signal: AbortSignal.timeout(30000),
          })
        : await this.api<{ result?: unknown; error?: { message: string } }>(
            "rpc",
            {
              context: { workspaceId: this.profile.workspaceId, pluginId },
              request,
            },
          );
    invariant(
      response && "result" in response,
      "COMMAND_FAILED",
      response && "error" in response
        ? (response.error?.message ?? "Core command failed")
        : "Core command failed",
    );
    return response.result;
  }
  notifySurfaces() {
    this.surfacesVersion++;
    for (const listener of this.surfaceListeners) listener();
  }
  private async refreshHost() {
    const key = JSON.stringify([
      [...this.registry.states.values()].map((s) => [
        s.id,
        s.version,
        s.enabled,
        s.features,
      ]),
      this.extensions.map((e) => e.digest),
    ]);
    if (this.closed || (this.host && key === this.hostState)) return;
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
  }

  async initialize(requestPassword?: () => Promise<string>) {
    await activateWorkspace(this.profile.workspaceId, requestPassword);
    let extensions =
      (await this.db.getMetadata<ExtensionContract[]>("core.extensions")) ?? [];
    this.registerPackages(extensions);
    this.inventory =
      await this.db.getMetadata<PluginInventory>("core.inventory");
    this.availablePlugins = this.inventory?.plugins ?? [];
    this.device = await browserDevice();
    this.node = this.device
      .profiles()
      .some((p) => p.id === this.profile.workspaceId)
      ? await this.device.workspace(this.profile.workspaceId)
      : await this.device.createWorkspace(
          this.profile.name,
          this.profile.workspaceId,
          this.profile.userId,
        );
    this.profile.connected = true;
    this.profile.userId = this.node.replica.member.userId;
    this.principal.userId = this.profile.userId;
    this.principal.deviceId = deviceRecordId(this.device.identity.id);
    this.automationOptions =
      (await this.db.getMetadata("device.automation")) ??
      this.automationOptions;
    this.allowRemotePlugins =
      (await this.db.getMetadata<boolean>("device.remotePlugins")) ?? false;
    this.device.setCapabilities(() => [
      "core.plugins.status",
      "core.services.release",
      ...(this.allowRemotePlugins ? ["core.plugins.install"] : []),
      ...(this.automationOptions.enabled && this.automationOptions.trustedCode
        ? ["automation.typescript"]
        : []),
      "records.storage",
      "files.storage",
      "credentials.refresh",
      ...(this.automationOptions.enabled
        ? ["automation.*", "automation.execute"]
        : []),
    ]);
    const native = window.taskasaurNative;
    if (native) {
      const info = await native.peer.info();
      if (!info.workspaces.includes(this.profile.workspaceId)) {
        if (
          currentPolicy(this.node.replica.access).owner.id ===
          this.device.identity.id
        ) {
          await native.peer.join(
            await this.device.approve(this.profile.workspaceId, info.request),
          );
          info.workspaces.push(this.profile.workspaceId);
        } else if (this.node.replica.access.credential) {
          const credential = this.node.replica.access.credential;
          const grant = await delegateDevice(
            credential,
            this.node.replica.access,
            JSON.parse(info.request).identity,
          );
          await native.peer.join(
            JSON.stringify({
              format: "taskasaur-pairing-v1",
              policies: this.node.replica.access.policies,
              peers: this.node.link.peers,
              delegations: [
                ...(this.node.replica.access.delegations ?? []).filter(
                  (d) => d.identity.id !== grant.identity.id,
                ),
                grant,
              ],
            }),
            credential,
          );
          info.workspaces.push(this.profile.workspaceId);
        }
      }
      if (info.workspaces.includes(this.profile.workspaceId)) {
        await native.peer.select(this.profile.workspaceId);
        await this.device.setPeers(this.profile.workspaceId, [
          "local:desktop",
          ...this.node.link.peers,
        ]);
      }
    }
    // One-time import of previously downloaded records; retain the old database for rollback.
    if (!(await this.db.getMetadata("peer.migrated"))) {
      for (const record of await this.db.records.toArray()) {
        if (record.workspaceId !== this.profile.workspaceId) continue;
        if (!this.node.records.get(record.id))
          await this.node.replica.update(
            "record/" + record.id,
            record as unknown as Record<string, unknown>,
          );
      }
      for (const version of await this.db.fileVersions.toArray()) {
        if (
          this.node.records.get(version.fileId)?.workspaceId !==
          this.profile.workspaceId
        )
          continue;
        await this.node.protocol.files.save(
          version.fileId,
          new Uint8Array(await version.blob.arrayBuffer()),
          version.blob.type,
          version.parentVersionId,
          version.id,
        );
      }
      await this.db.setMetadata("peer.migrated", true);
      await this.db.outbox.clear();
    }
    this.db.replicaBridge = {
      canWrite: () => this.node.records.canWrite(),
      put: async (collection, data, id, managedBy) => {
        const record = await this.node.records.put(collection, data, id, {
          managedBy,
        });
        const slot = slotFor(record);
        if (
          slot?.targetField &&
          typeof record.data[slot.targetField] === "string"
        ) {
          const current = bindingFor(this.node, slot, record.id);
          const enabled = slot.enabledField
            ? record.data[slot.enabledField] === true
            : (current?.enabled ?? false);
          if (
            !current ||
            deviceRecordId(current.deviceId) !==
              record.data[slot.targetField] ||
            current.enabled !== enabled
          )
            await configureExecution(
              this.node,
              record,
              slot,
              String(record.data[slot.targetField]),
              enabled,
            );
        }
        await this.project();
        return this.node.records.get(record.id)!;
      },
      delete: async (id) => {
        await this.node.records.delete(id);
        await this.project();
      },
      saveFile: async (id, blob, parent) => {
        const file = this.node.records.get(id);
        invariant(
          file?.collection === "files",
          "NOT_FOUND",
          "File record was not found",
        );
        const version = await this.node.protocol.files.save(
          id,
          new Uint8Array(await blob.arrayBuffer()),
          blob.type || "application/octet-stream",
          parent,
        );
        await this.node.records.put(
          "files",
          {
            ...file.data,
            version_id: version.id,
            size: String(version.size),
            media_type: version.mediaType,
            checksum: version.checksum,
            upload_state: "available",
          },
          id,
        );
        await this.project();
        return version.id;
      },
    };
    this.projectionListener = (id) => {
      void (async () => {
        await this.project();
        if (id.startsWith("event/") && this.host) {
          const event =
            this.node.replica.read<
              import("@taskasaur/platform/plugin-sdk").PluginEvent
            >(id);
          if (event) await this.host.deliver(event);
        }
      })().catch((e) => {
        this.node.replica.error = String(e);
        this.notifySurfaces();
      });
    };
    this.node.replica.listeners.add(this.projectionListener);
    await this.project();
    await this.registry.initialize();
    this.extensions = extensions;
    await this.refreshHost();
    this.automation = new PortableWorkflows(
      this.node,
      {
        deviceId: this.principal.deviceId!,
        canRun: async (execution) => {
          const run = this.node.records.get(execution.id),
            record = run && this.node.records.get(String(run.data.workflow_id));
          return Boolean(
            record &&
            executionReady(record, slotFor(record)!, this.pluginDeviceStatus()),
          );
        },
        call: async (command, input, operationId) => {
          const routed = executionRecord(this.node, command, input);
          if (routed)
            await requireExecution(this.node, routed.record, routed.slot);
          invariant(
            this.host?.router.has(command),
            "CAPABILITY_UNSUPPORTED",
            "This device does not provide the workflow command",
          );
          const result = await this.host!.router.receive(
            { jsonrpc: "2.0", id: operationId, method: command, params: input },
            {
              principal: {
                ...this.principal,
                permissions: [
                  this.host!.router.permissionFor(command) ?? command,
                ],
              },
              signal: AbortSignal.timeout(30000),
              mutationId: operationId,
            },
          );
          invariant(
            result && "result" in result,
            "COMMAND_FAILED",
            result?.error?.message ?? "Workflow command failed",
          );
          return result.result as import("@taskasaur/platform/field-types").Value;
        },
        typescript: async (source, input) => {
          invariant(
            this.automationOptions.trustedCode,
            "PERMISSION_DENIED",
            "Trusted TypeScript was disabled",
          );
          return runBrowserTypeScript(source, input);
        },
      },
      () => this.automationOptions,
    );
    this.node.protocol.setHandler(async (command, input, context) => {
      if (command === "core.plugins.status") return this.pluginDeviceStatus();
      if (command === "core.plugins.install") {
        invariant(
          this.allowRemotePlugins,
          "CAPABILITY_UNSUPPORTED",
          "Allow remote plugin installation on this device first",
        );
        const policy = currentPolicy(this.node.replica.access);
        invariant(
          policy.members[context.deviceId]?.userId ===
            policy.members[policy.owner.id].userId,
          "PERMISSION_DENIED",
          "The workspace owner must approve plugin installation",
        );
        const pin = input as {
          id: string;
          version: string;
          sha256: string;
          grants: string[];
        };
        await this.refreshInventory();
        const entry = this.availablePlugins.find((p) => p.id === pin.id);
        invariant(
          entry && entry.version === pin.version && entry.sha256 === pin.sha256,
          "INVENTORY_CHANGED",
          "The plugin release changed; review it again",
        );
        invariant(
          entry.grants.every((g) => pin.grants.includes(g)),
          "PERMISSION_DENIED",
          "Review the required permissions",
        );
        await this.pluginAction(pin.id, "install", pin.sha256);
        await this.pluginAction(pin.id, "enable");
        return { ok: true };
      }
      if (command === "core.services.release") {
        const request = input as {
          id: string;
          token: string;
          successor?: { deviceId: string; generation: string };
        };
        invariant(
          request.id.startsWith("execution."),
          "UNSUPPORTED_SERVICE",
          "This app only hosts per-item execution",
        );
        await releaseService(
          this.node,
          request.id,
          request.token,
          () => this.automation.releaseWorkflow(request.id.split(".")[1]),
          request.successor,
        );
        return { ok: true };
      }
      if (command === "credentials.refresh") {
        const request = input as {
          id: string;
          pluginId: string;
          destination: string;
        };
        await this.node.vault.refresh(
          request.id,
          request.pluginId,
          request.destination,
        );
        return { ok: true };
      }
      if (
        !command.startsWith("automation.") &&
        this.host?.router.has(command)
      ) {
        const routed = executionRecord(this.node, command, input);
        if (routed)
          await requireExecution(this.node, routed.record, routed.slot);
        const member = currentPolicy(this.node.replica.access).members[
          context.deviceId
        ];
        const response = await this.host.router.receive(
          {
            jsonrpc: "2.0",
            id: context.requestId,
            method: command,
            params: input,
          },
          {
            principal: {
              ...this.principal,
              userId: member.userId,
              deviceId: deviceRecordId(context.deviceId),
              permissions: [this.host.router.permissionFor(command) ?? command],
            },
            signal: AbortSignal.timeout(30000),
            mutationId: context.requestId,
          },
        );
        invariant(
          response && "result" in response,
          "COMMAND_FAILED",
          response?.error?.message ?? "Plugin command failed",
        );
        return response.result;
      }
      return this.localAutomation(command, input as Record<string, any>);
    });
    void this.refreshInventory()
      .then(async () => {
        if (this.closed) return;
        // Former built-ins keep their installed/enabled state and stored records.
        for (const state of this.registry.states.values())
          if (
            state.installed &&
            !isRequiredCore(state.id) &&
            !this.extensions.some((e) => e.manifest.id === state.id)
          ) {
            try {
              await this.ensurePackage(state.id);
            } catch (error) {
              this.inventoryError =
                error instanceof Error ? error.message : String(error);
            }
          }
        await this.refreshHost();
        this.notifySurfaces();
      })
      .catch((error) => {
        this.inventoryError = String(error);
        this.notifySurfaces();
      });
    await ensureCollectionTables(this);
    return this;
  }
  pluginDeviceStatus(): DevicePluginStatus {
    return {
      deviceId: this.device.identity.id,
      capabilities: this.node.protocol.capabilities(),
      canInstall: this.allowRemotePlugins,
      plugins: this.registry.list().map(({ manifest, state }) => ({
        id: manifest.id,
        version: state.version,
        installed: state.installed,
        enabled: state.enabled,
        ...((state.error ?? this.host?.failures.get(manifest.id))
          ? { error: state.error ?? this.host?.failures.get(manifest.id) }
          : {}),
      })),
    };
  }
  async configureRemotePlugins(enabled: boolean) {
    this.allowRemotePlugins = enabled;
    await this.db.setMetadata("device.remotePlugins", enabled);
    this.notifySurfaces();
  }
  async configureItemExecution(
    record: ResourceRecord,
    slot: ExecutionSlot,
    deviceId: string,
    enabled: boolean,
  ) {
    await configureExecution(this.node, record, slot, deviceId, enabled);
    await this.project();
    await this.node.synchronize();
    this.notifySurfaces();
  }
  async executionInstallPlan(
    record: ResourceRecord,
    slot: ExecutionSlot,
    deviceId: string,
  ) {
    await this.refreshInventory();
    const status = (
      await inspectExecution(this.node, record, slot)
    ).candidates.find((p) => p.id === deviceId || p.recordId === deviceId);
    invariant(
      status?.online && status.statusKnown,
      "DEVICE_UNAVAILABLE",
      "Connect the execution computer before installing plugins",
    );
    invariant(
      status.canInstall,
      "CAPABILITY_UNSUPPORTED",
      "Allow remote plugin installation on that computer first",
    );
    const plan: InventoryEntry[] = [],
      seen = new Set<string>(),
      visiting = new Set<string>();
    const visit = (id: string) => {
      if (seen.has(id)) return;
      invariant(
        !visiting.has(id),
        "DEPENDENCY_CYCLE",
        "Plugin dependencies contain a cycle",
      );
      visiting.add(id);
      const entry = this.availablePlugins.find((p) => p.id === id);
      if (!entry) {
        invariant(
          isRequiredCore(id),
          "PLUGIN_NOT_FOUND",
          `${id} is missing from the plugin inventory`,
        );
        return;
      }
      for (const dependency of entry.dependencies) visit(dependency);
      const installed = status.plugins.find((p) => p.id === id);
      if (
        !installed?.installed ||
        !installed.enabled ||
        installed.version !== entry.version ||
        installed.error
      )
        plan.push(entry);
      visiting.delete(id);
      seen.add(id);
    };
    for (const requirement of executionRequirements(slot, record).plugins) {
      if (requirement.version)
        invariant(
          this.availablePlugins.find((p) => p.id === requirement.id)
            ?.version === requirement.version,
          "PLUGIN_VERSION_UNAVAILABLE",
          `The inventory does not offer required ${requirement.id}@${requirement.version}`,
        );
      visit(requirement.id);
    }
    return plan;
  }
  async installExecutionPlugins(deviceId: string, plan: InventoryEntry[]) {
    for (const entry of plan)
      await this.node.call(
        "core.plugins.install",
        {
          id: entry.id,
          version: entry.version,
          sha256: entry.sha256,
          grants: entry.grants,
        },
        deviceId,
      );
    await this.node.synchronize();
    this.notifySurfaces();
  }
  async configureAutomation(value: { enabled: boolean; trustedCode: boolean }) {
    this.automationOptions = value;
    await this.db.setMetadata("device.automation", value);
    await this.announce();
    this.notifySurfaces();
  }
  private localAutomation(command: string, input: Record<string, any>) {
    invariant(
      !this.closed && this.automationOptions.enabled,
      "CAPABILITY_UNSUPPORTED",
      "Automation execution is disabled on this device",
    );
    if (command === "automation.run") {
      const record = this.node.records.get(input.id);
      invariant(record, "NOT_FOUND", "Automation not found");
      const slot = slotFor(record)!;
      invariant(
        executionReady(record, slot, this.pluginDeviceStatus()),
        "PLUGIN_NOT_READY",
        "Enable the required plugins and capabilities on the execution computer",
      );
      return this.automation.start(
        input as Parameters<PortableWorkflows["start"]>[0],
      );
    }
    if (command === "automation.cancel")
      return this.automation.cancel(input.id).then(() => ({ ok: true }));
    if (command === "automation.signal")
      return this.automation.signal(input.id, input.name, input.data);
    throw new CoreError(
      "CAPABILITY_UNSUPPORTED",
      "This operation needs a different device capability",
    );
  }
  private lastAnnouncement = 0;
  private async announce() {
    if (
      this.node.records.canWrite() &&
      Date.now() - this.lastAnnouncement > 30000
    ) {
      const platform = window.taskasaurNative
        ? "desktop"
        : (await import("@capacitor/core")).Capacitor.getPlatform();
      const data = {
          name: window.taskasaurNative
            ? "This computer (app)"
            : this.device.identity.name,
          platform: platform === "web" ? "browser" : platform,
          capabilities: this.node.protocol.capabilities(),
        },
        old = this.node.records.get(this.principal.deviceId!);
      if (
        !old ||
        Object.entries(data).some(
          ([key, value]) =>
            JSON.stringify(old.data[key]) !== JSON.stringify(value),
        )
      )
        await this.node.records.put(
          "devices",
          { ...data, last_seen: new Date().toISOString() },
          this.principal.deviceId,
        );
      this.lastAnnouncement = Date.now();
    }
  }
  collection(id: string, allTables = false) {
    this.assertActive();
    const schema = getSchema(id);
    const source = this.db
      .scoped(
        { ...this.principal, pluginId: schema.pluginId },
        schema.pluginId,
        this.profile.connected ? "synced" : "local-only",
      )
      .collection(id);
    return allTables ? source : scopedTableStore(this, id, source);
  }
  async project() {
    const work = async () => {
      if (this.closed || !this.node) return;
      const records = this.node.records.all(),
        ids = new Set(records.map((r) => r.id));
      await this.db.transaction(
        "rw",
        this.db.records,
        this.db.searchDocuments,
        async () => {
          const obsolete = (
            await this.db.records.toCollection().primaryKeys()
          ).filter((id) => !ids.has(id));
          if (obsolete.length) await this.db.records.bulkDelete(obsolete);
          await this.db.searchDocuments.bulkDelete([
            ...obsolete,
            ...records.filter((r) => r.deletedAt).map((r) => r.id),
          ]);
          await this.db.records.bulkPut(records);
        },
      );
      const released = (await this.db.fileVersions.toArray()).filter(
        (v) => !this.node.protocol.files.retainedVersion(v.id),
      );
      if (released.length) {
        await this.db.fileVersions.bulkDelete(released.map((v) => v.id));
        await this.db.searchDocuments.bulkDelete(released.map((v) => v.fileId));
      }
      for (const version of this.node.protocol.files.manifests()) {
        if (!this.node.protocol.files.retainedVersion(version.id)) continue;
        if (await this.db.fileVersions.get(version.id)) continue;
        try {
          const { bytes } = await this.node.protocol.files.read(version.id);
          await this.db.fileVersions.put({
            id: version.id,
            fileId: version.fileId,
            parentVersionId: version.parentVersionId,
            blob: new Blob([new Uint8Array(bytes)], {
              type: version.mediaType,
            }),
            createdAt: version.createdAt,
            synced: true,
          });
        } catch (error) {
          if ((error as { kind?: string }).kind !== "OFFLINE_UNAVAILABLE")
            throw error;
        }
      }
      this.notifySurfaces();
    };
    const next = this.projectionQueue.then(work);
    this.projectionQueue = next.catch(() => {});
    return next;
  }
  async api<T = unknown>(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<T> {
    this.assertActive();
    const url = new URL(path, "https://local.invalid/"),
      route = url.pathname.slice(1),
      input = (body ?? {}) as Record<string, any>;
    let result: unknown;
    if (route === "records/get")
      result = this.node.records.get(url.searchParams.get("id")!);
    else if (route === "devices")
      result = await this.db.records
        .where("collection")
        .equals("devices")
        .toArray();
    else if (route === "credentials/secret") {
      await this.node.vault.set(input.id, input.secret, input.deviceIds);
      await this.project();
      result = { ok: true };
    } else if (route === "credentials/revoke") {
      await this.node.vault.revoke(input.id);
      await this.project();
      result = { ok: true };
    } else if (route === "devices/revoke") {
      const id =
        Object.keys(currentPolicy(this.node.replica.access).members).find(
          (id) => deviceRecordId(id) === input.id,
        ) ?? input.id;
      await this.device.revoke(this.profile.workspaceId, id);
      result = { ok: true };
    } else if (route === "rpc") {
      const request = input.request;
      const routed = executionRecord(this.node, request.method, request.params);
      const binding =
        routed && bindingFor(this.node, routed.slot, routed.record.id);
      if (routed)
        invariant(
          binding?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable execution for this item",
        );
      const requested = input.context?.targetDeviceId;
      if (binding && requested)
        invariant(
          [binding.deviceId, deviceRecordId(binding.deviceId)].includes(
            requested,
          ),
          "WRONG_EXECUTION_TARGET",
          "Use the computer assigned to this item",
        );
      const target = binding?.deviceId ?? requested,
        localTarget =
          !target ||
          target === this.principal.deviceId ||
          target === this.device.identity.id;
      if (localTarget && target)
        invariant(
          this.host?.router.has(request.method),
          "CAPABILITY_UNSUPPORTED",
          "This device does not provide that command",
        );
      if (localTarget && this.host?.router.has(request.method))
        result = await this.host.router.receive(request, {
          principal: {
            ...this.principal,
            pluginId: input.context.pluginId,
            permissions: [
              this.host.router.permissionFor(request.method) ?? request.method,
            ],
          },
          signal: AbortSignal.timeout(30000),
        });
      else {
        invariant(
          target,
          "EXECUTION_UNASSIGNED",
          "Select a target for remote commands or declare an item execution slot",
        );
        result = {
          result: await this.node.call(
            request.method,
            request.params,
            target,
            request.id,
          ),
        };
      }
    } else if (route === "access/members")
      result = Object.values(
        currentPolicy(this.node.replica.access).members,
      ).map((m) => ({ user_id: m.userId, role: m.role }));
    else if (route === "github/create-task") {
      invariant(
        this.registry.enabled("connector-github") &&
          this.registry.enabled("tasks") &&
          this.registry.states
            .get("connector-github")
            ?.features.includes("taskLinks"),
        "FEATURE_DISABLED",
        "Enable GitHub task links and the Tasks plugin",
      );
      const issue = this.node.records.get(input.id);
      invariant(
        issue?.collection === "github_issues" && !issue.deletedAt,
        "NOT_FOUND",
        "Issue not found",
      );
      const id =
        typeof issue.data.task_id === "string"
          ? issue.data.task_id
          : await operationId(issue.id + ":task");
      result =
        this.node.records.get(id) ??
        (await this.collection("tasks").put(
          {
            title: String(issue.data.title),
            description: `${issue.data.body ?? ""}\n\n${issue.data.url ?? ""}`,
            status: issue.data.state === "closed" ? "done" : "open",
          },
          id,
        ));
      if (issue.data.task_id !== id)
        await this.collection("github_issues").put(
          { ...issue.data, task_id: id },
          issue.id,
        );
    } else if (route === "automation/webhook") {
      const record = this.node.records.get(input.id),
        slot = record && slotFor(record);
      const binding = record && slot && bindingFor(this.node, slot, record.id);
      invariant(
        binding?.enabled,
        "EXECUTION_PAUSED",
        "Choose a computer and enable this automation first",
      );
      const target = deviceRecordId(binding.deviceId);
      invariant(
        typeof target === "string",
        "WRONG_EXECUTION_TARGET",
        "Select a native execution device to receive webhooks",
      );
      await this.node.synchronize();
      result = await this.node.call(
        "core.http",
        { path, body, method },
        target,
      );
    } else if (
      ["automation/run", "automation/cancel", "automation/signal"].includes(
        route,
      )
    ) {
      const item = this.node.records.get(input.id);
      const slot = item && slotFor(item);
      const assignment =
        item && slot ? bindingFor(this.node, slot, item.id) : undefined;
      if (route === "automation/run")
        invariant(
          assignment?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable this automation before running it",
        );
      const target = assignment
        ? deviceRecordId(assignment.deviceId)
        : item?.data.target_device_id;
      if (input.targetDeviceId)
        invariant(
          input.targetDeviceId === target,
          "WRONG_EXECUTION_TARGET",
          "Use the computer assigned to this item",
        );
      if (route === "automation/run") input.targetDeviceId = target;
      invariant(
        typeof target === "string",
        "WRONG_EXECUTION_TARGET",
        "Select an execution device",
      );
      if (target === this.principal.deviceId)
        result = await this.localAutomation(route.replace("/", "."), input);
      else {
        await this.node.synchronize();
        try {
          result = await this.node.call(
            route.replace("/", "."),
            input,
            target,
            input.operationId,
          );
        } catch (error) {
          const workflow = this.node.records.get(input.id);
          if (
            route !== "automation/run" ||
            workflow?.data.offline_policy !== "waitForDevice" ||
            !["DEVICE_UNAVAILABLE", "OFFLINE"].includes(
              (error as { kind?: string }).kind ?? "",
            )
          )
            throw error;
          const operationId = input.operationId ?? crypto.randomUUID();
          await this.node.enqueue(
            "automation.run",
            { ...input, operationId },
            target,
            operationId,
            Date.now() +
              Math.min(
                86400,
                Number(workflow.data.dispatch_timeout_seconds) || 3600,
              ) *
                1000,
          );
          result = await this.node.records.put(
            "workflow_runs",
            {
              workflow_id: input.id,
              target_device_id: target,
              workflow_version: Number(workflow.data.published_version),
              status: "queued",
              input: input.input ?? {},
            },
            operationId,
          );
        }
        await this.node.synchronize();
        await this.project();
      }
    } else {
      await this.node.synchronize();
      const provider = [...this.registry.manifests.values()].find((m) =>
        m.server?.routes.some((r) =>
          r.path.endsWith("*")
            ? route.startsWith(r.path.slice(0, -1))
            : r.path === route,
        ),
      );
      const routed = executionRecord(
        this.node,
        route === "jobs" ? input.command : route,
        route === "jobs" ? input.input : input,
      );
      const assignment =
        routed && bindingFor(this.node, routed.slot, routed.record.id);
      if (routed)
        invariant(
          assignment?.enabled,
          "EXECUTION_PAUSED",
          "Choose a computer and enable execution for this item",
        );
      const target =
        assignment?.deviceId ?? input.targetDeviceId ?? input.deviceId;
      invariant(
        target,
        "EXECUTION_UNASSIGNED",
        "This operation needs an item-specific execution computer",
      );
      result = await this.node.call(
        "core.http",
        { path, body: body ?? null, method },
        target,
      );
      await this.node.synchronize();
      await this.project();
    }
    return result as T;
  }
  async pluginAction(
    id: string,
    action: "install" | "enable" | "disable" | "uninstall",
    reviewedDigest?: string,
  ) {
    if (action === "install") await this.ensurePackage(id, reviewedDigest);
    const result = await this.registry[action](id);
    await this.refreshHost();
    if (action === "enable") await ensureCollectionTables(this);
    if (action === "disable" || action === "uninstall")
      await this.db.metadata.put({
        key: `plugin.${id}.disabledAt`,
        value: new Date().toISOString(),
      });
    return result;
  }
  async installAndEnable(
    id: string,
    visiting = new Set<string>(),
    reviewed?: Map<string, string>,
  ) {
    invariant(
      !visiting.has(id),
      "DEPENDENCY_CYCLE",
      "Plugin dependency cycle detected",
    );
    visiting.add(id);
    if (!this.inventory) await this.refreshInventory();
    const entry = this.availablePlugins.find((p) => p.id === id);
    if (reviewed && !isRequiredCore(id))
      invariant(
        reviewed.has(id) &&
          (entry?.sha256 ?? this.installedPackage(id)?.digest) ===
            reviewed.get(id),
        "INVENTORY_CHANGED",
        "The release or dependencies changed; review them again",
      );
    const dependencies =
      entry?.dependencies ??
      this.registry.manifests.get(id)?.dependencies ??
      [];
    for (const dep of dependencies)
      if (!this.registry.enabled(dep))
        await this.installAndEnable(dep, new Set(visiting), reviewed);
    await this.pluginAction(id, "install", reviewed?.get(id));
    await this.pluginAction(id, "enable");
  }
  async configurePlugin(id: string, features: string[]) {
    await this.registry.configure(id, features);
    await this.refreshHost();
  }
  async synchronize() {
    if (this.closed) return;
    return this.syncQueue.run(async () => {
      if (this.closed) return;
      await this.announce();
      await this.node.synchronize();
      await this.node.flushCommands();
      if (this.automationOptions.enabled)
        await workflowTriggers(this.node, (input) =>
          this.automation.start(
            input as Parameters<PortableWorkflows["start"]>[0],
          ),
        );
      await this.automation?.tick();
      await reminders(this.node, (id) => this.registry.enabled(id));
      await this.project();
    });
  }
  async fileBytes(fileId: string) {
    this.assertActive();
    const file = this.node.records.get(fileId);
    invariant(file?.data.version_id, "NOT_FOUND", "File has no saved version");
    const { manifest, bytes } = await this.node.protocol.files.read(
      String(file.data.version_id),
    );
    return {
      id: manifest.id,
      fileId,
      parentVersionId: manifest.parentVersionId,
      blob: new Blob([new Uint8Array(bytes)], { type: manifest.mediaType }),
      createdAt: manifest.createdAt,
      synced: true,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.syncQueue.idle().catch(() => {});
    await this.automation?.close();
    if (this.projectionListener)
      this.node?.replica.listeners.delete(this.projectionListener);
    await this.projectionQueue;
    await this.host?.close();
    this.surfaces.clear();
    this.notifySurfaces();
    this.db.close();
    if (this.node) {
      await this.device.closeWorkspace(this.node.replica.workspaceId);
      await window.taskasaurNative?.peer.select();
    }
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
  const device = await browserDevice(),
    node = await device.createWorkspace(name);
  return profileForNode(node);
}
export async function joinWorkspace(invitation: string) {
  const node = await (await browserDevice()).join(invitation);
  return profileForNode(node);
}
export async function profileForNode(node: WorkspaceNode) {
  const profile: WorkspaceProfile = {
    id: node.replica.workspaceId,
    workspaceId: node.replica.workspaceId,
    userId: node.replica.member.userId,
    name: node.link.name,
    serverUrl: "",
    connected: true,
  };
  await saveProfile(profile);
  return profile;
}
export { browserDevice };
