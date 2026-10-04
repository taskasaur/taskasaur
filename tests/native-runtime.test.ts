import { MemoryStorage } from "../packages/storage";
import { canonical } from "../packages/core/crypto";
import { configureExecution, slotFor } from "../packages/core/execution";
import { registryFor } from "../packages/platform-node/compat/api";
import { Repository } from "../packages/platform-node/compat/repository";
import { it, expect } from "vitest";
import { mkdtemp, rm, readdir } from "node:fs/promises";
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
    const status = await services.execute(
      node.replica.workspaceId,
      "core.plugins.status",
      {},
      { deviceId: core.identity.id, requestId: crypto.randomUUID() },
    );
    expect(() => JSON.parse(canonical(status))).not.toThrow();
    await expect(
      services.execute(
        node.replica.workspaceId,
        "core.plugins.install",
        {},
        { deviceId: core.identity.id, requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow("installation is disabled");
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
    await configureExecution(
      node,
      workflow,
      slotFor(workflow)!,
      core.identity.id,
      true,
    );
    const registry = registryFor(new Repository((services as any).db), {
      workspaceId: node.replica.workspaceId,
      userId: node.replica.member.userId,
      pluginId: "automation-runtime",
      permissions: [],
    });
    await registry.initialize();
    await registry.install("automation-runtime");
    await registry.enable("automation-runtime");
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
it("claims mail jobs only for their enabled account and rejects orphaned execution items", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-item-jobs-"),
  );
  let services: NativeServices;
  const core = await DeviceCore.open(
      new FileStorage(path.join(directory, "replicas")),
      "Mail worker",
      () => services?.capabilities() ?? [],
    ),
    node = await core.createWorkspace("Accounts");
  services = new NativeServices(core, {
    directory,
    terminal: false,
    automation: false,
    trustedCode: false,
    background: true,
    plugins: false,
  });
  try {
    await services.initialize();
    const repo = new Repository((services as any).db),
      actor = {
        workspaceId: node.replica.workspaceId,
        userId: node.replica.member.userId,
        pluginId: "email-client",
        permissions: [],
      },
      registry = registryFor(repo, actor);
    await registry.initialize();
    await registry.install("email-client");
    await registry.enable("email-client");
    const account = await node.records.put("mail_accounts", {
      name: "Account A",
      address: "a@example.test",
      credential_id: crypto.randomUUID(),
      imap_host: "imap.example.test",
      smtp_host: "smtp.example.test",
      smtp_security: "tls",
    });
    await configureExecution(
      node,
      account,
      slotFor(account)!,
      core.identity.id,
      true,
    );
    const message = await node.records.put("mail", {
      account_id: account.id,
      subject: "Queued",
      status: "queued",
      send_operation_id: crypto.randomUUID(),
    });
    await services.project();
    const { JobService } =
      await import("../packages/platform-node/compat/jobs");
    const jobs = new JobService(repo);
    await expect(
      jobs.enqueue(actor, "mail.send", { id: crypto.randomUUID() }),
    ).rejects.toThrow("execution item");
    await jobs.enqueue(actor, "mail.send", { id: message.id });
    await configureExecution(
      node,
      node.records.get(account.id)!,
      slotFor(account)!,
      core.identity.id,
      false,
    );
    expect(await jobs.claim("test-worker")).toBeUndefined();
    await configureExecution(
      node,
      node.records.get(account.id)!,
      slotFor(account)!,
      core.identity.id,
      true,
    );
    const claim = await jobs.claim("test-worker");
    expect(claim?.payload.execution?.resourceId).toBe(account.id);
    await jobs.settle(claim!);
    await jobs.enqueue(actor, "mail.send", { id: message.id });
    await node.records.put(
      "mail",
      { ...message.data, account_id: null },
      message.id,
    );
    expect(await jobs.claim("test-worker")).toBeUndefined();
  } finally {
    await services.close();
    await core.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

it("reopens linked workspaces as a storage-only peer without creating a SQL projection", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-storage-peer-"),
  );
  const storage = new FileStorage(path.join(directory, "replicas"));
  const owner = await DeviceCore.open(new MemoryStorage(), "Owner");
  const workspace = await owner.createWorkspace("Existing workspace");
  const original = await DeviceCore.open(storage, "Cloud peer");
  const joined = await original.join(
    await owner.approve(
      workspace.replica.workspaceId,
      original.pairingRequest(),
    ),
  );
  const core = await DeviceCore.open(storage, "Restarted");
  const services = new NativeServices(core, {
    directory,
    storageOnly: true,
    terminal: false,
    automation: false,
    trustedCode: false,
    background: false,
    plugins: false,
  });
  try {
    await services.initialize();
    expect(core.workspaces.has(joined.replica.workspaceId)).toBe(true);
    expect(services.capabilities()).toEqual(["storage.peer"]);
    await services.tick();
    expect(await readdir(directory)).toEqual(["replicas"]);
    await expect(
      services.execute(
        joined.replica.workspaceId,
        "core.plugins.status",
        {},
        { deviceId: core.identity.id, requestId: crypto.randomUUID() },
      ),
    ).rejects.toThrow("only provides storage");
  } finally {
    await services.close();
    await core.close();
    await original.close();
    await owner.close();
    await rm(directory, { recursive: true, force: true });
  }
});
it("activates only the selected desktop workspace and closes its peer handler on switching", async () => {
  const { startNativeRuntime } =
    await import("../packages/platform-node/runtime");
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-selected-peer-"),
  );
  let runtime: Awaited<ReturnType<typeof startNativeRuntime>> | undefined;
  try {
    const setup = await DeviceCore.open(
      new FileStorage(path.join(directory, "replicas")),
      "Desktop",
    );
    const a = await setup.createWorkspace("A"),
      b = await setup.createWorkspace("B");
    const aId = a.replica.workspaceId,
      bId = b.replica.workspaceId;
    await setup.close();
    runtime = await startNativeRuntime({
      directory,
      activeWorkspaces: [],
      storageOnly: true,
      network: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    });
    expect(runtime.core.workspaces.size).toBe(0);
    await runtime.selectWorkspace(aId);
    const selected = runtime.core.workspaces.get(aId)!;
    const packet = await selected.protocol.pack({ kind: "capabilities" });
    await runtime.selectWorkspace(bId);
    expect([...runtime.core.workspaces.keys()]).toEqual([bId]);
    await expect(selected.protocol.receive(packet)).rejects.toThrow("closed");
    await runtime.selectWorkspace();
    expect(runtime.core.protocols.size).toBe(0);
  } finally {
    await runtime?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
