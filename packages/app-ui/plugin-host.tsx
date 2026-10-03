import { navigationService } from "./navigation-service";
import { ExecutionTarget, type ExecutionTargetProps } from "./execution-target";
import { executionService, executionRecord } from "../core/execution";
import { coreModules } from "@taskasaur/platform/core/modules";
import { sharedReact } from "../ui/html-controls";
import { Capacitor } from "@capacitor/core";
import { peerService } from "../core/peer-service";
import { credentialHttp } from "../core/credential-http";
import { pluginWorkspace, pluginModules } from "./plugin-modules";
import * as React from "react";
import { PluginHost } from "@taskasaur/platform/core/host";
import { getSchema, isRequiredCore } from "@taskasaur/platform/core/catalog";
import {
  field,
  decodeField,
  validateRecord,
} from "@taskasaur/platform/field-types";
import { invariant } from "@taskasaur/platform/core/errors";
import type {
  PluginManifest,
  PluginModule,
  PluginEvent,
  Mutation,
  ResourceRecord,
} from "@taskasaur/platform/plugin-sdk";
import type { AppRuntime } from "./runtime";
import { RecordTable, type RecordTableProps } from "./record-table";
import { CollectionView } from "../ui/collection-view";
import { QueryControls } from "../ui/query-controls";
import { ChoiceSelect } from "../ui/choice-select";
import { RecordForm, FieldInput } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
export interface ExtensionContract {
  manifest: PluginManifest;
  schemas: unknown;
  grants: string[];
  digest: string;
  browserDigest?: string;
  coreDigest?: string;
}
export interface Surface {
  id: string;
  pluginId: string;
  label: string;
  main?: boolean;
  icon?: string;
  render: React.ComponentType;
}
export async function createBrowserPluginHost(
  runtime: AppRuntime,
  extensions: ExtensionContract[],
) {
  const local = runtime.db,
    actor = runtime.principal;
  const platform = window.taskasaurNative ? "desktop" : Capacitor.getPlatform();
  const host: PluginHost = new PluginHost(
    runtime.registry,
    actor,
    platform === "ios" || platform === "android" || platform === "desktop"
      ? platform
      : "browser",
    {
      cleanup: (id) => {
        for (const [key, command] of runtime.commands)
          if (command.pluginId === id) runtime.commands.delete(key);
        for (const [key] of runtime.searchOptions)
          if (getSchema(key).pluginId === id) runtime.searchOptions.delete(key);
        for (const [key, surface] of runtime.surfaces)
          if (surface.pluginId === id) runtime.surfaces.delete(key);
        for (const style of document.querySelectorAll<HTMLStyleElement>(
          "style[data-taskasaur-plugin]",
        ))
          if (style.dataset.taskasaurPlugin === id) style.remove();
        runtime.notifySurfaces();
      },
      services: (principal) => {
        const id = principal.pluginId,
          manifest = runtime.registry.manifests.get(id)!;
        const grants =
          extensions.find((e) => e.manifest.id === id)?.grants ?? [];
        const scoped = () =>
          local.scoped(
            principal,
            id,
            runtime.profile.connected ? "synced" : "local-only",
          );
        const collection = (name: string) => {
          invariant(
            getSchema(name).pluginId === id,
            "UNDECLARED_COLLECTION",
            "Use core messages for another plugin collection",
          );
          return scoped().collection(name);
        };
        const settings = () => ({
          get: async (key: string) =>
            runtime.node.replica.read<{ value: unknown }>(
              `setting/plugin.${id}.${key}`,
            )?.value,
          set: (key: string, value: unknown) =>
            runtime.node.replica.update(`setting/plugin.${id}.${key}`, {
              value,
            }),
        });
        const sharedStore = (name: string) => {
          const store = local.scoped(principal, name).collection(name);
          const owned = async (resourceId?: string) => {
            const record = resourceId
              ? await local.records.get(resourceId)
              : undefined;
            invariant(
              !record || record.managedBy === id,
              "PERMISSION_DENIED",
              "Use declared write commands to modify resources your plugin does not manage",
            );
          };
          return {
            list: store.list,
            put: async (
              data: Record<
                string,
                import("@taskasaur/platform/field-types").Value
              >,
              resourceId?: string,
            ) => {
              await owned(resourceId);
              return store.put(data, resourceId);
            },
            delete: async (resourceId: string) => {
              await owned(resourceId);
              await store.delete(resourceId);
            },
          };
        };
        return new Map<string, unknown>([
          ["core.workspace", pluginWorkspace(runtime, manifest, grants)],
          ["core.records", { collection }],
          ["core.modules", coreModules],
          [
            "core.storage.local",
            {
              collection,
              capabilities: {
                atomicRecords: true,
                multiRecordTransactions: false,
              },
              transaction: async () => {
                throw new Error(
                  "Multi-record transactions are unavailable. Use durable individual writes with stable operation IDs.",
                );
              },
            },
          ],
          ["core.fields", { field, getSchema, decodeField, validateRecord }],
          ["core.settings", settings()],
          [
            "credentials.use",
            {
              request: (
                credentialId: string,
                destination: string,
                options?: {
                  method?: string;
                  body?: import("@taskasaur/platform/field-types").Value;
                },
              ) =>
                credentialHttp(
                  runtime.node.vault,
                  id,
                  credentialId,
                  destination,
                  options,
                ),
            },
          ],
          [
            "core.sync",
            {
              synchronize: () => runtime.synchronize(),
              status: () => runtime.node.replica.status(),
            },
          ],
          ["core.variables", sharedStore("variables")],
          [
            "core.tables",
            {
              ...sharedStore("tables"),
              rows: async (tableId: string) => {
                const table = await local.records.get(tableId);
                invariant(
                  table?.collection === "tables" && !table.deletedAt,
                  "NOT_FOUND",
                  "Table is unavailable",
                );
                const target =
                  typeof table.data.collection_id === "string"
                    ? table.data.collection_id
                    : "table_rows";
                invariant(
                  target === "table_rows" ||
                    table.managedBy === id ||
                    (manifest.consumes.commands.includes(target + ".list") &&
                      grants.includes(target + ".list")),
                  "PERMISSION_DENIED",
                  "Declare permission to read another plugin's table",
                );
                return (await runtime.collection(target, true).list()).filter(
                  (row) =>
                    row.data.table_id === tableId ||
                    (target !== "table_rows" &&
                      table.data.is_default &&
                      !row.data.table_id),
                );
              },
            },
          ],
          [
            "core.devices",
            { list: () => runtime.collection("devices").list() },
          ],
          ["core.peers", peerService(runtime.node)],
          ["core.execution", executionService(runtime.node, id, grants)],
          [
            "core.access",
            { canWrite: (record: ResourceRecord) => local.canWrite(record) },
          ],
          [
            "files.access",
            {
              read: async (id: string) => (await runtime.fileBytes(id)).blob,
              write: (id: string, blob: Blob, parent: string | null) =>
                local.saveFile(principal, id, blob, parent),
            },
          ],
          [
            "core.notifications",
            {
              notify: (title: string, body: string, resourceId?: string) =>
                runtime
                  .collection("notifications")
                  .put({ title, body, resource_id: resourceId ?? null }),
            },
          ],
          [
            "core.jobs",
            {
              enqueue: (
                command: string,
                input: unknown,
                options?:
                  | string
                  | {
                      dueAt?: string;
                      operationId?: string;
                      targetDeviceId?: string;
                    },
              ) =>
                runtime.api("jobs", {
                  pluginId: id,
                  command,
                  input,
                  ...(typeof options === "string"
                    ? { dueAt: options }
                    : options),
                }),
            },
          ],
          [
            "core.ui",
            {
              React: sharedReact,
              modules: pluginModules(runtime, manifest, grants),
              addStyles: (css: string) => {
                const style = document.createElement("style");
                style.dataset.taskasaurPlugin = id;
                style.textContent = css;
                document.head.append(style);
                return () => style.remove();
              },
              Button,
              Input,
              RecordForm,
              FieldInput,
              CollectionView,
              QueryControls,
              ChoiceSelect,
              ...navigationService(runtime, manifest),
              ExecutionTarget: (
                props: Omit<ExecutionTargetProps, "runtime">,
              ) => {
                const record = runtime.node.records.get(props.resourceId);
                invariant(
                  record?.pluginId === id,
                  "UNDECLARED_COLLECTION",
                  "Execution item must belong to this plugin",
                );
                return <ExecutionTarget {...props} runtime={runtime} />;
              },
              RecordTable: (props: Omit<RecordTableProps, "runtime">) => {
                const name = props.collection;
                invariant(
                  manifest.storage.local.collections.includes(name),
                  "UNDECLARED_COLLECTION",
                  "UI collection is not owned by this plugin",
                );
                return (
                  <RecordTable
                    {...props}
                    runtime={runtime}
                    collection={name}
                    managedAccess={id}
                  />
                );
              },
              registerSurface: (surface: {
                id: string;
                label: string;
                main?: boolean;
                icon?: string;
                render: React.ComponentType;
              }) => {
                invariant(
                  manifest.ui.mode === "shared" &&
                    manifest.ui.surfaces.includes(surface.id),
                  "UNDECLARED_SURFACE",
                  "Declare this UI surface in the manifest",
                );
                const key = id + ":" + surface.id;
                invariant(
                  !runtime.surfaces.has(key),
                  "CONTRACT_COLLISION",
                  "UI surface is already registered",
                );
                const render =
                  id === "email-client" && manifest.version === "1.0.0"
                    ? React.lazy(async () => {
                        const { default: MailView } =
                          await import("./mail-view");
                        return {
                          default: () => <MailView runtime={runtime} />,
                        };
                      })
                    : id === "automation-editor" && manifest.version === "1.0.0"
                      ? React.lazy(async () => {
                          const { default: AutomationView } =
                            await import("./automation-view");
                          return {
                            default: () => <AutomationView runtime={runtime} />,
                          };
                        })
                      : id === "tasks" && manifest.version === "1.0.0"
                        ? React.lazy(async () => {
                            const { TasksView } = await import("./tasks-view");
                            return {
                              default: () => <TasksView runtime={runtime} />,
                            };
                          })
                        : id === "remote-terminal" &&
                            manifest.version === "1.0.0"
                          ? React.lazy(async () => {
                              const { PeerTerminal } =
                                await import("./peer-terminal");
                              return {
                                default: () => (
                                  <PeerTerminal runtime={runtime} />
                                ),
                              };
                            })
                          : id === "sharing" && manifest.version === "1.0.0"
                            ? React.lazy(async () => {
                                const { PeerSharing } =
                                  await import("./peer-sharing");
                                return {
                                  default: () => (
                                    <PeerSharing runtime={runtime} />
                                  ),
                                };
                              })
                            : id === "office-editor" &&
                                manifest.version === "1.0.0"
                              ? React.lazy(async () => {
                                  const { PortableOffice } =
                                    await import("./portable-office");
                                  return {
                                    default: () => (
                                      <PortableOffice
                                        runtime={runtime}
                                        legacy={surface.render}
                                      />
                                    ),
                                  };
                                })
                              : surface.render;
                const registered = {
                  ...surface,
                  render,
                  id: key,
                  pluginId: id,
                };
                runtime.surfaces.set(key, registered);
                runtime.notifySurfaces();
                return () => {
                  if (runtime.surfaces.get(key) !== registered) return;
                  runtime.surfaces.delete(key);
                  runtime.notifySurfaces();
                };
              },
            },
          ],
        ]);
      },
      call: async (command, input, principal, options) => {
        if (
          options?.targetDeviceId ||
          executionRecord(runtime.node, command, input) ||
          !host.router.has(command)
        ) {
          const result = await runtime.api<{
            result: unknown;
            error?: { message: string };
          }>("rpc", {
            context: {
              workspaceId: actor.workspaceId,
              pluginId: principal.pluginId,
              targetDeviceId: options?.targetDeviceId,
            },
            request: {
              jsonrpc: "2.0",
              id: options?.mutationId ?? crypto.randomUUID(),
              method: command,
              params: input,
            },
          });
          invariant(
            !result.error,
            "COMMAND_FAILED",
            result.error?.message ?? "Command failed",
          );
          return result.result;
        }
        const result = await host.router.receive(
          {
            jsonrpc: "2.0",
            id: options?.mutationId ?? crypto.randomUUID(),
            method: command,
            params: input,
          },
          {
            principal: {
              ...principal,
              permissions: [
                ...principal.permissions,
                host.router.permissionFor(command) ?? command,
              ],
            },
            signal: AbortSignal.timeout(30000),
          },
        );
        invariant(
          result && "result" in result,
          "COMMAND_FAILED",
          "Local command failed",
        );
        return result.result;
      },
      publish: async (event, principal) => {
        const record = await local.records.get(event.data.resourceId);
        invariant(
          record?.workspaceId === actor.workspaceId,
          "PERMISSION_DENIED",
          "Event resource is unavailable",
        );
        await runtime.node.replica.update(
          "event/" + event.id,
          event as unknown as Record<string, unknown>,
        );
      },
    },
  );
  for (const manifest of runtime.registry.manifests.values())
    for (const command of manifest.provides.commands) {
      const match = /^(.+)\.(list|put|delete)$/.exec(command);
      if (!match || !manifest.storage.local.collections.includes(match[1]))
        continue;
      host.router.register(command, {
        permission: command,
        validate: (value) => value,
        execute: async (input, context) => {
          const store = local
            .scoped(
              context.principal,
              manifest.id,
              runtime.profile.connected ? "synced" : "local-only",
            )
            .collection(match[1]);
          if (match[2] === "list") return store.list(input as never);
          const mutation = input as Mutation;
          invariant(
            mutation.collection === match[1] &&
              mutation.pluginId === manifest.id,
            "VALIDATION_FAILED",
            "Mutation collection mismatch",
          );
          if (match[2] === "put")
            return store.put(mutation.data, mutation.resourceId);
          await store.delete(mutation.resourceId);
          return null;
        },
      });
    }
  for (const extension of extensions) {
    const manifest = extension.manifest;
    if (!runtime.registry.enabled(manifest.id)) continue;
    const modules: PluginModule[] = [];
    try {
      for (const [entry, digest, key] of [
        [
          manifest.entrypoints.core,
          extension.coreDigest,
          `extension.core.${extension.digest}`,
        ],
        [
          manifest.entrypoints.browser,
          extension.browserDigest,
          `extension.source.${extension.digest}`,
        ],
      ]) {
        if (!entry) continue;
        const source = await local.getMetadata<string>(key!);
        invariant(
          source && digest,
          "INVALID_PACKAGE",
          "Plugin module is unavailable; reinstall the verified package",
        );
        const bytes = new TextEncoder().encode(source),
          hash = Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          )
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
        invariant(
          hash === digest,
          "INTEGRITY_FAILED",
          "Plugin module integrity check failed",
        );
        const url = URL.createObjectURL(
          new Blob([source], { type: "text/javascript" }),
        );
        try {
          const imported = await import(/* @vite-ignore */ url);
          invariant(
            typeof imported.default?.activate === "function",
            "INVALID_PACKAGE",
            "Plugin must export activate(context)",
          );
          modules.push(imported.default);
        } finally {
          URL.revokeObjectURL(url);
        }
      }
      if (!modules.length) continue;
      host.register(
        {
          manifest,
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
        },
        extension.grants,
      );
      await host.activate(manifest.id);
    } catch (error) {
      host.unavailable(manifest.id, error);
    }
  }

  for (const extension of extensions) {
    const state = runtime.registry.states.get(extension.manifest.id);
    if (state)
      await local.plugins.put({
        ...state,
        error: host.failures.get(extension.manifest.id),
      });
  }
  return host;
}
