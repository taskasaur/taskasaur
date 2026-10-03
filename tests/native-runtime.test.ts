import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FileStorage } from "../packages/platform-node/storage";
import { DeviceCore } from "../packages/core/device";
import { NativeServices } from "../packages/platform-node/services";
import { NativeTerminal } from "../packages/platform-node/terminal";
import { deviceRecordId } from "../packages/core/records";
it("starts native services with an embedded projection and no external database or auth service", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskasaur-native-"));
  const core = await DeviceCore.open(
    new FileStorage(path.join(directory, "replicas")),
    "Native test",
  );
  const node = await core.createWorkspace("Local workspace");
  const services = new NativeServices(core, {
    directory,
    terminal: false,
    automation: false,
    trustedCode: false,
    background: false,
    plugins: false,
  });
  try {
    await services.initialize();
    const record = await node.records.put("variables", {
      name: "Portable variable",
      value: "hello",
      value_type: "text",
    });
    await services.tick();
    expect(node.records.get(record.id)?.data.name).toBe("Portable variable");
    expect(services.capabilities()).not.toContain("terminal.host");
    await expect(
      services.execute(
        node.replica.workspaceId,
        "terminal.open",
        {},
        { deviceId: core.identity.id, requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow("disabled");
  } finally {
    await services.close();
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);
it("hosts a real native shell with session ownership and revocation", async () => {
  const terminal = new NativeTerminal();
  try {
    const opened = (await terminal.command(
      "terminal.open",
      {},
      "owner",
      "workspace",
      crypto.randomUUID(),
    )) as { sessionId: string };
    await expect(
      terminal.command(
        "terminal.input",
        { sessionId: opened.sessionId, data: "echo forbidden\r" },
        "other",
        "workspace",
        "bad",
      ),
    ).rejects.toThrow("unavailable");
    await terminal.command(
      "terminal.input",
      { sessionId: opened.sessionId, data: "printf 'taskasaur-pty-ok\\n'\r" },
      "owner",
      "workspace",
      "write-once",
    );
    await expect
      .poll(
        async () =>
          JSON.stringify(
            await terminal.command(
              "terminal.poll",
              { sessionId: opened.sessionId },
              "owner",
              "workspace",
              "poll",
            ),
          ),
        { timeout: 10000 },
      )
      .toContain("taskasaur-pty-ok");
    terminal.sweep(() => false);
    await expect(
      terminal.command(
        "terminal.poll",
        { sessionId: opened.sessionId },
        "owner",
        "workspace",
        "poll",
      ),
    ).rejects.toThrow("unavailable");
  } finally {
    terminal.close();
  }
}, 20000);
it("executes a published TypeScript graph on the explicitly selected native device", async () => {
  const directory = await mkdtemp(
      path.join(os.tmpdir(), "taskasaur-workflow-"),
    ),
    core = await DeviceCore.open(
      new FileStorage(path.join(directory, "replicas")),
      "Runner",
    ),
    node = await core.createWorkspace("Workflows");
  const services = new NativeServices(core, {
      directory,
      terminal: false,
      automation: true,
      trustedCode: true,
      background: false,
      plugins: false,
    }),
    target = deviceRecordId(core.identity.id);
  try {
    await services.initialize();
    const workflow = await node.records.put("workflows", {
      name: "Native TypeScript",
      allow_trusted_code: true,
      target_device_id: target,
      published_version: 1,
      graph: {
        nodes: [
          {
            id: "calculate",
            type: "typescript",
            config: {
              source: "const value: number = 6 * 7; return { answer: value };",
            },
          },
        ],
        edges: [],
      },
    });
    const id = crypto.randomUUID();
    await services.execute(
      node.replica.workspaceId,
      "automation.run",
      { id: workflow.id, targetDeviceId: target, operationId: id },
      { deviceId: core.identity.id, requestId: crypto.randomUUID() },
    );
    await expect
      .poll(
        async () => {
          await services.tick();
          return node.records.get(id)?.data.status;
        },
        { timeout: 25000 },
      )
      .toBe("completed");
    expect(node.records.get(id)?.data.output).toEqual({ answer: 42 });
    const revision = node.records.get(id)?.revision;
    await services.tick();
    expect(node.records.get(id)?.revision).toBe(revision);
  } finally {
    await services.close();
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);
