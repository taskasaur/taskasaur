"use client";
import * as React from "react";
import { PluginHost } from "../core/host";
import { getSchema, isRequiredCore } from "../core/catalog";
import { field, decodeField, validateRecord } from "../field-types";
import { invariant } from "../core/errors";
import type {
  PluginManifest,
  PluginModule,
  PluginEvent,
  Mutation,
  ResourceRecord,
} from "../plugin-sdk";
import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
import { RecordForm, FieldInput } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
export interface ExtensionContract {
  manifest: PluginManifest;
  schemas: unknown;
  grants: string[];
  digest: string;
  browserDigest?: string;
}
export interface Surface {
  id: string;
  pluginId: string;
  label: string;
  render: React.ComponentType;
}
export async function createBrowserPluginHost(
  runtime: AppRuntime,
  extensions: ExtensionContract[],
) {
  const local = runtime.db,
    actor = runtime.principal;
  const host: PluginHost = new PluginHost(runtime.registry, actor, "browser", {
    cleanup: (id) => {
      for (const [key, surface] of runtime.surfaces)
        if (surface.pluginId === id) runtime.surfaces.delete(key);
      runtime.notifySurfaces();
    },
    services: (principal) => {
      const id = principal.pluginId,
        manifest = runtime.registry.manifests.get(id)!;
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
        get: async (key: string) => local.getMetadata(`settings.${id}.${key}`),
        set: (key: string, value: unknown) =>
          local.setMetadata(`settings.${id}.${key}`, value),
      });
      return new Map<string, unknown>([
        ["core.records", { collection }],
        [
          "core.storage.local",
          {
            collection,
            transaction: <T,>(execute: () => Promise<T>) =>
              local.transaction(
                "rw",
                local.records,
                local.outbox,
                local.plugins,
                local.metadata,
                execute,
              ),
          },
        ],
        ["core.fields", { field, getSchema, decodeField, validateRecord }],
        ["core.settings", settings()],
        [
          "core.sync",
          {
            synchronize: () => runtime.synchronize(),
            status: () => local.outbox.toArray(),
          },
        ],
        [
          "core.variables",
          { list: () => runtime.collection("variables").list() },
        ],
        [
          "core.tables",
          {
            list: () => runtime.collection("tables").list(),
            rows: (id: string) =>
              runtime.collection("table_rows").list({
                filters: [
                  {
                    id: "table",
                    field: "table_id",
                    operator: "eq",
                    value: id,
                    enabled: true,
                    link: "and",
                  },
                ],
              }),
          },
        ],
        ["core.devices", { list: () => runtime.collection("devices").list() }],
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
            enqueue: (command: string, input: unknown, dueAt?: string) =>
              runtime.api("jobs", { pluginId: id, command, input, dueAt }),
          },
        ],
        [
          "core.ui",
          {
            React,
            Button,
            Input,
            RecordForm,
            FieldInput,
            RecordTable: ({ collection: name }: { collection: string }) => {
              invariant(
                manifest.storage.local.collections.includes(name),
                "UNDECLARED_COLLECTION",
                "UI collection is not owned by this plugin",
              );
              return <RecordTable runtime={runtime} collection={name} />;
            },
            registerSurface: (surface: {
              id: string;
              label: string;
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
              const registered = { ...surface, id: key, pluginId: id };
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
      invariant(
        !options?.targetDeviceId ||
          options.targetDeviceId === principal.deviceId,
        "CAPABILITY_UNSUPPORTED",
        "This command has no handler on the selected device",
      );
      if (options?.targetDeviceId || !host.router.has(command)) {
        const result = await runtime.api<{
          result: unknown;
          error?: { message: string };
        }>("rpc", {
          context: {
            workspaceId: actor.workspaceId,
            pluginId: principal.pluginId,
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
      if (runtime.profile.connected)
        await runtime.api("events", { pluginId: principal.pluginId, event });
      await host.deliver(event);
    },
  });
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
              { ...context.principal, pluginId: manifest.id },
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
    if (!runtime.registry.enabled(manifest.id) || !manifest.entrypoints.browser)
      continue;
    try {
      const key = `extension.source.${extension.digest}`;
      let source = await local.getMetadata<string>(key);
      if (!source && runtime.profile.connected) {
        const result = await runtime.api<{ source: string }>(
          "plugins/source?id=" + encodeURIComponent(manifest.id),
        );
        source = result.source;
      }
      invariant(
        source && extension.browserDigest,
        "INVALID_PACKAGE",
        "Browser module is unavailable on this device",
      );
      const bytes = new TextEncoder().encode(source),
        hash = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      invariant(
        hash === extension.browserDigest,
        "INTEGRITY_FAILED",
        "Browser module integrity check failed",
      );
      await local.setMetadata(key, source);
      const url = URL.createObjectURL(
        new Blob([source], { type: "text/javascript" }),
      );
      try {
        const imported = await import(
          /* webpackIgnore: true */ /* @vite-ignore */ url
        );
        const module: PluginModule = { ...imported.default, manifest };
        invariant(
          typeof module.activate === "function",
          "INVALID_PACKAGE",
          "Browser entrypoint must export activate(context)",
        );
        host.register(module, extension.grants);
        await host.activate(manifest.id);
      } finally {
        URL.revokeObjectURL(url);
      }
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
