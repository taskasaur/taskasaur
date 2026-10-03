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
              options: {
                id?: string;
                revision?: number;
                mutationId?: string;
              } = {},
            ) =>
              repo.mutate(
                actor,
                {
                  id: options.mutationId ?? randomUUID(),
                  resourceId: options.id ?? randomUUID(),
                  pluginId: actor.pluginId,
                  collection: id,
                  operation: "put",
                  baseRevision: options.revision ?? 0,
                  data,
                  createdAt: new Date().toISOString(),
                },
                "plugin",
              ),
          };
        };
        return new Map<string, unknown>([
          ["core.server", serverAdapter(repo, actor)],
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
          ["core.variables", { list: () => repo.list(actor, "variables") }],
          [
            "core.tables",
            {
              list: () => repo.list(actor, "tables"),
              rows: (id: string) =>
                repo.list(actor, "table_rows", {
                  filters: [
                    {
                      id: "table",
                      field: "table_id",
                      operator: "eq",
                      link: "and",
                      enabled: true,
                      value: id,
                    },
                  ],
                }),
            },
          ],
          ["core.records", { collection }],
          [
            "core.settings",
            {
              get: (key: string) =>
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
              request: async (
                id: string,
                destination: string,
                options: { method?: string; body?: Value } = {},
              ) => {
                const url = new URL(destination);
                invariant(
                  url.protocol === "https:",
                  "TLS_REQUIRED",
                  "Credential HTTP operations require HTTPS",
                );
                const broker = new CredentialBroker(
                  repo,
                  process.env.CREDENTIAL_ENCRYPTION_KEY ?? "",
                );
                return broker.use(
                  actor,
                  id,
                  actor.pluginId,
                  destination,
                  "http.request",
                  async (secret) => {
                    const response = await fetch(url, {
                      method: options.method ?? "GET",
                      redirect: "error",
                      signal: AbortSignal.timeout(15000),
                      headers: {
                        Authorization: secret.accessToken
                          ? "Bearer " + secret.accessToken
                          : secret.apiKey
                            ? "Bearer " + secret.apiKey
                            : "Basic " +
                              Buffer.from(
                                `${secret.username ?? ""}:${secret.password ?? ""}`,
                              ).toString("base64"),
                        "Content-Type": "application/json",
                      },
                      ...(options.body == null
                        ? {}
                        : { body: JSON.stringify(options.body) }),
                    });
                    invariant(
                      response.ok,
                      "HTTP_ERROR",
                      `Provider returned ${response.status}`,
                    );
                    return response.json();
                  },
                );
              },
            },
          ],
        ]);
      },
      call: async (command, input, actor, options) => {
        if (
          options?.targetDeviceId &&
          options.targetDeviceId !== actor.deviceId
        )
          return repo.db.core.workspaces
            .get(actor.workspaceId)!
            .call(command, input, options.targetDeviceId, options.mutationId);
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
