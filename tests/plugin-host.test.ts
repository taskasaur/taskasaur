import { it, expect } from "vitest";
import { PluginRegistry } from "../packages/core/registry";
import { PluginHost } from "../packages/core/host";
import { manifestById } from "../packages/core/catalog";
import type { CoreContext, PluginManifest } from "../packages/plugin-sdk";
const manifest = (id: string): PluginManifest => ({
  ...manifestById.get("tasks")!,
  id,
  publisher: "fixture",
  dependencies: [],
  permissions: [],
  entrypoints: { server: "server.mjs" },
  storage: { local: { mode: "none", collections: [] } },
  ui: { mode: "none", surfaces: [] },
  sharedServices: [{ id: "core.settings", version: "^1", optional: false }],
  provides: { commands: [id + ".read"], events: [] },
  consumes: { commands: [], events: [] },
});
it("removes failed plugin registrations and revokes previously obtained service handles", async () => {
  const registry = new PluginRegistry({
    load: async () => [],
    save: async () => {},
  });
  await registry.initialize();
  const saved: string[] = [];
  let held: any;
  const host = new PluginHost(
    registry,
    {
      workspaceId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      pluginId: "records",
      permissions: [],
    },
    "server",
    {
      services: () =>
        new Map([
          [
            "core.settings",
            {
              set: (key: string) => {
                saved.push(key);
              },
            },
          ],
        ]),
      call: async () => null,
      publish: async () => {},
    },
  );
  const bad = manifest("fixture.bad"),
    good = manifest("fixture.good");
  host.register(
    {
      manifest: bad,
      activate: async (context) => {
        held = context.services.require("core.settings");
        context.messages.handle(
          "fixture.bad.read",
          {
            id: "empty",
            pluginId: bad.id,
            name: "empty",
            version: 1,
            fields: [],
          },
          async () => null,
        );
        throw new Error("private activation detail");
      },
    },
    ["core.settings"],
  );
  host.register(
    {
      manifest: good,
      activate: async (context) => {
        context.messages.handle(
          "fixture.good.read",
          {
            id: "empty",
            pluginId: good.id,
            name: "empty",
            version: 1,
            fields: [],
          },
          async () => ({ ready: true }),
        );
      },
    },
    ["core.settings"],
  );
  for (const id of [bad.id, good.id]) {
    await registry.install(id);
    await registry.enable(id);
  }
  await expect(host.activate(bad.id)).rejects.toThrow();
  expect(host.router.has("fixture.bad.read")).toBe(false);
  expect(host.failures.get(bad.id)).toBe("PLUGIN_ACTIVATION_FAILED");
  expect(() => held.set("late")).toThrow();
  expect(saved).toEqual([]);
  await host.activate(good.id);
  expect(host.router.has("fixture.good.read")).toBe(true);
  await host.close();
  expect(host.router.has("fixture.good.read")).toBe(false);
});
it("continues disabling after a plugin cleanup fails and allows a clean reactivation", async () => {
  const registry = new PluginRegistry({
    load: async () => [],
    save: async () => {},
  });
  await registry.initialize();
  let context: CoreContext | undefined,
    starts = 0;
  let unregister: (() => void) | undefined;
  const host = new PluginHost(
    registry,
    {
      workspaceId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      pluginId: "records",
      permissions: [],
    },
    "server",
    {
      services: () => new Map(),
      call: async () => null,
      publish: async () => {},
    },
  );
  const plugin = manifest("fixture.cleanup");
  host.register(
    {
      manifest: plugin,
      activate: async (ctx) => {
        context = ctx;
        starts++;
        unregister = ctx.messages.handle(
          "fixture.cleanup.read",
          {
            id: "empty",
            pluginId: plugin.id,
            name: "empty",
            version: 1,
            fields: [],
          },
          async () => null,
        );
        return () => {
          throw new Error("Cleanup failed");
        };
      },
    },
    [],
  );
  await registry.install(plugin.id);
  await registry.enable(plugin.id);
  await host.activate(plugin.id);
  const oldContext = context!;
  const oldUnregister = unregister!;
  await registry.disable(plugin.id);
  expect(context!.signal.aborted).toBe(true);
  expect(host.router.has("fixture.cleanup.read")).toBe(false);
  expect(registry.enabled(plugin.id)).toBe(false);
  await registry.enable(plugin.id);
  await host.activate(plugin.id);
  expect(starts).toBe(2);
  oldUnregister();
  expect(host.router.has("fixture.cleanup.read")).toBe(true);
  await expect(
    oldContext.messages.call("fixture.cleanup.read", {}),
  ).rejects.toThrow();
  await host.activate(plugin.id);
  expect(starts).toBe(2);
  await host.close();
});
