import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { PluginHost } from "../packages/core/host";
import { PluginRegistry } from "../packages/core/registry";
import { getSchema } from "../packages/core/catalog";
import {
  validateRecord,
  decodeField,
  field,
  type Value,
} from "../packages/field-types";
import { invariant } from "../packages/core/errors";
import type {
  Principal,
  PluginModule,
  PluginEvent,
} from "../packages/plugin-sdk";
import type { MessageRouter } from "../packages/core/messages";
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
        invariant(
          !options?.targetDeviceId || options.targetDeviceId === actor.deviceId,
          "CAPABILITY_UNSUPPORTED",
          "This command has no handler on the selected device",
        );
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
      entry.manifest.entrypoints.server
    ) {
      try {
        const url = pathToFileURL(
          entry.directory + "/" + entry.manifest.entrypoints.server,
        ).href;
        const imported = await import(/* webpackIgnore: true */ url);
        const module: PluginModule = {
          ...imported.default,
          manifest: entry.manifest,
        };
        invariant(
          typeof module.activate === "function",
          "INVALID_PACKAGE",
          "Plugin must export activate(context)",
        );
        host.register(module, entry.grants);
        await host.activate(entry.manifest.id);
      } catch (error) {
        host.unavailable(entry.manifest.id, error);
      }
    }
  return host;
}
