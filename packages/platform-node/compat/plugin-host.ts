import { deviceRecordId } from "../../core/records";
import { credentialHttp } from "../../core/credential-http";
import {
  executionService,
  executionRecord,
  bindingFor,
  requireExecution,
} from "../../core/execution";
import { coreModules } from "@taskasaur/platform/core/modules";
import { peerService } from "../../core/peer-service";
import { serverAdapter } from "./plugin-runtime";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PluginHost } from "@taskasaur/platform/core/host";
import { PluginRegistry } from "@taskasaur/platform/core/registry";
import { getSchema } from "@taskasaur/platform/core/catalog";
import {
  validateRecord,
  decodeField,
  field,
  type Value,
} from "@taskasaur/platform/field-types";
import { invariant } from "@taskasaur/platform/core/errors";
import type {
  Principal,
  PluginModule,
  PluginEvent,
} from "@taskasaur/platform/plugin-sdk";
import type { MessageRouter } from "@taskasaur/platform/core/messages";
import type { Repository } from "./repository";
import { loadPackageCatalog } from "./plugin-packages";
import { CredentialBroker } from "./credentials";
import { FileService } from "./files";
import { JobService } from "./jobs";
import { publishEvent } from "./events";
export async function serverPluginHost(
  repo: Repository,
  principal: Principal,
  router: MessageRouter,
) {
  const packages = await loadPackageCatalog(),
    registry = new PluginRegistry({
      load: async () => [],
      save: async () => {
        throw new Error("Use the plugin administration API");
      },
    });
  const states = await repo.db.query<{
    id: string;
    version: string;
    installed: boolean;
    enabled: boolean;
    features: string[];
  }>(
    "SELECT id,version,installed,enabled,features FROM taskasaur.plugins WHERE workspace_id=$1",
    [principal.workspaceId],
  );
  for (const state of states.rows) registry.states.set(state.id, state);
  const host = new PluginHost(
    registry,
    principal,
    "server",
    {
      services: (actor) => {
        const manifest = registry.manifests.get(actor.pluginId)!;
        const collection = (id: string) => {
          invariant(
            getSchema(id).pluginId === actor.pluginId,
            "UNDECLARED_COLLECTION",
            "Use a declared core command to access another plugin",
          );
          return {
            list: (query?: never) => repo.list(actor, id, query),
            get: async (resourceId: string) => {
              const record = await repo.get(actor, resourceId);
              invariant(
                record.collection === id,
                "UNDECLARED_COLLECTION",
                "Resource belongs to another collection",
              );
              return record;
            },
            put: async (
              data: Record<string, Value>,
              options:
                | string
                | {
                    id?: string;
                    revision?: number;
                    mutationId?: string;
                  } = {},
            ) =>
              repo.mutate(
                actor,
                {
                  id:
                    (typeof options === "string"
                      ? undefined
                      : options.mutationId) ?? randomUUID(),
                  resourceId:
                    (typeof options === "string" ? options : options.id) ??
                    randomUUID(),
                  pluginId: actor.pluginId,
                  collection: id,
                  operation: "put",
                  baseRevision:
                    (typeof options === "string" ? 0 : options.revision) ?? 0,
                  data,
                  createdAt: new Date().toISOString(),
                },
                "plugin",
              ),
            delete: async (
              resourceId: string,
              options: { mutationId?: string } = {},
            ) => {
              const record = await repo.get(actor, resourceId);
              invariant(
                record.collection === id,
                "UNDECLARED_COLLECTION",
                "Resource belongs to another collection",
              );
              await repo.mutate(
                actor,
                {
                  id: options.mutationId ?? randomUUID(),
                  resourceId,
                  pluginId: actor.pluginId,
                  collection: id,
                  operation: "delete",
                  baseRevision: record.revision,
                  data: {},
                  createdAt: new Date().toISOString(),
                },
                "plugin",
              );
            },
          };
        };
        const sharedStore = (name: string) => ({
          list: () => repo.list(actor, name),
          put: async (
            data: Record<string, Value>,
            id: string = randomUUID(),
          ) => {
            const previous = repo.db.core.workspaces
              .get(actor.workspaceId)
              ?.records.get(id);
            invariant(
              !previous || previous.managedBy === actor.pluginId,
              "PERMISSION_DENIED",
              "Use declared write commands to modify resources your plugin does not manage",
            );
            return repo.mutate(actor, {
              id: randomUUID(),
              resourceId: id,
              collection: name,
              pluginId: name,
              operation: "put",
              baseRevision: previous?.revision ?? 0,
              data,
              createdAt: new Date().toISOString(),
            });
          },
          delete: async (id: string) => {
            const previous = await repo.get(actor, id);
            invariant(
              previous.collection === name &&
                previous.managedBy === actor.pluginId,
              "PERMISSION_DENIED",
              "Delete only resources managed by this plugin",
            );
            await repo.mutate(actor, {
              id: randomUUID(),
              resourceId: id,
              collection: name,
              pluginId: name,
              operation: "delete",
              baseRevision: previous.revision,
              data: {},
              createdAt: new Date().toISOString(),
            });
          },
        });
        return new Map<string, unknown>([
          ["core.server", serverAdapter(repo, actor)],
          [
            "core.execution",
            executionService(
              repo.db.core.workspaces.get(actor.workspaceId)!,
              actor.pluginId,
              packages.find((p) => p.manifest.id === actor.pluginId)?.grants ??
                [],
            ),
          ],
          [
            "core.jobs",
            {
              enqueue: (
                command: string,
                input: Value,
                options?: { operationId?: string; dueAt?: string },
              ) => new JobService(repo).enqueue(actor, command, input, options),
              cancel: (id: string) => new JobService(repo).cancel(actor, id),
            },
          ],
          [
            "core.schedules",
            {
              every: (seconds: number, command: string, input: Value) =>
                new JobService(repo).enqueue(actor, command, input, {
                  intervalSeconds: seconds,
                }),
            },
          ],
          [
            "core.notifications",
            {
              notify: (title: string, body: string, resourceId?: string) =>
                repo.mutate(actor, {
                  id: randomUUID(),
                  resourceId: randomUUID(),
                  pluginId: "notifications",
                  collection: "notifications",
                  operation: "put",
                  baseRevision: 0,
                  createdAt: new Date().toISOString(),
                  data: { title, body, resource_id: resourceId ?? null },
                }),
            },
          ],
          ["core.variables", sharedStore("variables")],
          [
            "core.tables",
            {
              ...sharedStore("tables"),
              rows: async (tableId: string) => {
                const table = await repo.get(actor, tableId);
                invariant(
                  table.collection === "tables" && !table.deletedAt,
                  "NOT_FOUND",
                  "Table is unavailable",
                );
                const target =
                  typeof table.data.collection_id === "string"
                    ? table.data.collection_id
                    : "table_rows";
                const grants =
                  packages.find((p) => p.manifest.id === actor.pluginId)
                    ?.grants ?? [];
                invariant(
                  target === "table_rows" ||
                    table.managedBy === actor.pluginId ||
                    (manifest.consumes.commands.includes(target + ".list") &&
                      grants.includes(target + ".list")),
                  "PERMISSION_DENIED",
                  "Declare permission to read another plugin's table",
                );
                return (await repo.list(actor, target)).filter(
                  (row) =>
                    row.data.table_id === tableId ||
                    (target !== "table_rows" &&
                      table.data.is_default &&
                      !row.data.table_id),
                );
              },
            },
          ],
          ["core.records", { collection }],
          [
            "core.storage.local",
            {
              collection,
              capabilities: {
                atomicRecords: true,
                multiRecordTransactions: false,
              },
              transaction: async () => {
                throw Error(
                  "Multi-record transactions are unavailable. Use durable individual writes with stable operation IDs.",
                );
              },
            },
          ],
          [
            "core.sync",
            {
              synchronize: () =>
                repo.db.core.workspaces.get(actor.workspaceId)!.synchronize(),
              status: () =>
                repo.db.core.workspaces
                  .get(actor.workspaceId)!
                  .replica.status(),
            },
          ],
          [
            "core.settings",
            {
              get: async (key: string) =>
                repo.db.core.workspaces
                  .get(actor.workspaceId)!
                  .replica.read<{ value: unknown }>(
                    `setting/plugin.${actor.pluginId}.${key}`,
                  )?.value,
              set: (key: string, value: unknown) =>
                repo.db.core.workspaces
                  .get(actor.workspaceId)!
                  .replica.update(`setting/plugin.${actor.pluginId}.${key}`, {
                    value,
                  }),
            },
          ],
          ["core.modules", coreModules],
          ["core.fields", { getSchema, validateRecord, decodeField, field }],
          [
            "core.access",
            {
              check: (id: string, write = false) =>
                repo.authorize(actor, id, write).then(() => true),
            },
          ],
          ["core.devices", { list: () => repo.list(actor, "devices") }],
          [
            "core.peers",
            peerService(repo.db.core.workspaces.get(actor.workspaceId)!),
          ],
          [
            "files.access",
            {
              read: async (id: string) =>
                Buffer.from(
                  await (
                    await new FileService(repo).download(actor, id)
                  ).arrayBuffer(),
                ).toString("base64"),
              write: (
                id: string,
                bytes: string,
                mediaType: string,
                parent: string | null,
                version: string,
              ) =>
                new FileService(repo).upload(
                  actor,
                  id,
                  Buffer.from(bytes, "base64"),
                  mediaType,
                  parent,
                  version,
                ),
            },
          ],
          [
            "credentials.use",
            {
              request: (
                id: string,
                destination: string,
                options?: { method?: string; body?: Value },
              ) =>
                credentialHttp(
                  repo.db.core.workspaces.get(actor.workspaceId)!.vault,
                  actor.pluginId,
                  id,
                  destination,
                  options,
                ),
            },
          ],
        ]);
      },
      call: async (command, input, actor, options) => {
        const node = repo.db.core.workspaces.get(actor.workspaceId)!;
        const routed = executionRecord(node, command, input),
          binding = routed && bindingFor(node, routed.slot, routed.record.id);
        if (routed)
          invariant(
            binding?.enabled,
            "EXECUTION_PAUSED",
            "Choose a computer and enable execution for this item",
          );
        if (binding && options?.targetDeviceId)
          invariant(
            [binding.deviceId, deviceRecordId(binding.deviceId)].includes(
              options.targetDeviceId,
            ),
            "WRONG_EXECUTION_TARGET",
            "Use the item’s assigned computer",
          );
        const target = binding?.deviceId ?? options?.targetDeviceId;
        if (
          target &&
          ![
            node.replica.identity.id,
            deviceRecordId(node.replica.identity.id),
          ].includes(target)
        )
          return node.call(command, input, target, options?.mutationId);
        if (routed) await requireExecution(node, routed.record, routed.slot);
        const result = await router.receive(
          {
            jsonrpc: "2.0",
            id: options?.mutationId ?? randomUUID(),
            method: command,
            params: input,
          },
          {
            principal: {
              ...actor,
              permissions: [
                ...actor.permissions,
                router.permissionFor(command) ?? command,
              ],
            },
            signal: AbortSignal.timeout(30000),
          },
        );
        invariant(
          result && "result" in result,
          "COMMAND_FAILED",
          "Core command failed",
        );
        return result.result;
      },
      publish: (event, actor) => publishEvent(repo, actor, event),
    },
    router,
  );
  for (const entry of packages)
    if (
      registry.enabled(entry.manifest.id) &&
      (entry.manifest.entrypoints.core || entry.manifest.entrypoints.server)
    ) {
      try {
        const modules: PluginModule[] = [];
        for (const file of [
          entry.manifest.entrypoints.core,
          entry.manifest.entrypoints.server,
        ].filter(Boolean)) {
          const imported = await import(
            /* @vite-ignore */ pathToFileURL(entry.directory + "/" + file).href
          );
          invariant(
            typeof imported.default?.activate === "function",
            "INVALID_PACKAGE",
            "Plugin must export activate(context)",
          );
          modules.push(imported.default);
        }
        const module: PluginModule = {
          manifest: entry.manifest,
          activate: async (context) => {
            const cleanups: Array<() => void | Promise<void>> = [];
            try {
              for (const module of modules) {
                const cleanup = await module.activate(context);
                if (cleanup) cleanups.push(cleanup);
              }
            } catch (error) {
              for (const cleanup of cleanups.reverse()) await cleanup();
              throw error;
            }
            return async () => {
              for (const cleanup of cleanups.reverse()) await cleanup();
            };
          },
        };
        host.register(module, entry.grants);
        await host.activate(entry.manifest.id);
      } catch (error) {
        host.unavailable(entry.manifest.id, error);
      }
    }
  return host;
}
