import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAutomationEngine, runTypeScript } from "../server/automation";
it("runs TypeScript graphs durably on the selected SQLite runner and deduplicates submissions", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-workflow-"),
  );
  const deviceId = crypto.randomUUID();
  let calls = 0;
  const host = {
    deviceId,
    call: async () => {
      calls++;
      return { created: true };
    },
  };
  const config = {
    kind: "sqlite" as const,
    path: path.join(directory, "workflow.sqlite"),
  };
  let engine = await createAutomationEngine(host, config);
  try {
    const execution = {
      id: crypto.randomUUID(),
      targetDeviceId: deviceId,
      allowTrustedCode: false,
      input: { test: true },
      graph: {
        nodes: [
          {
            id: "input",
            type: "input" as const,
            position: { x: 0, y: 0 },
            config: {},
          },
          {
            id: "create",
            type: "command" as const,
            position: { x: 0, y: 0 },
            config: { command: "tasks.put" },
          },
          {
            id: "wait",
            type: "wait" as const,
            position: { x: 0, y: 0 },
            config: { seconds: 1 },
          },
          {
            id: "output",
            type: "output" as const,
            position: { x: 0, y: 0 },
            config: {},
          },
        ],
        edges: [
          { id: "a", source: "input", target: "create" },
          { id: "b", source: "create", target: "wait" },
          { id: "c", source: "wait", target: "output" },
        ],
      },
    };
    await expect(
      engine.run({ ...execution, targetDeviceId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ kind: "WRONG_EXECUTION_TARGET" });
    const first = await engine.run(execution),
      second = await engine.run(execution);
    expect(first.workflowRun.id).toBe(second.workflowRun.id);
    // Persist the run, shut down, then recover it from a new engine instance.
    await engine.stop();
    engine = await createAutomationEngine(host, config);
    await engine.worker.start();
    const recovered = await engine.run(execution);
    expect(recovered.workflowRun.id).toBe(first.workflowRun.id);
    expect(await recovered.result({ timeoutMs: 15000 })).toEqual({
      created: true,
    });
    expect(calls).toBe(1);
  } finally {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
it("executes TypeScript and rejects module imports", async () => {
  expect(
    await runTypeScript(
      "const value = input as {count:number}; return value.count + 1;",
      { count: 2 },
    ),
  ).toBe(3);
  await expect(
    runTypeScript('import fs from "node:fs"; return 1;', null),
  ).rejects.toMatchObject({ kind: "IMPORT_NOT_ALLOWED" });
  await expect(
    runTypeScript('const count: number = "wrong"; return count;', null),
  ).rejects.toMatchObject({ kind: "TYPESCRIPT_TYPE_ERROR" });
});
it("checkpoints bounded loops, deterministic parallel joins, mappings and error routes in interpreter v2", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "taskasaur-graph-v2-"),
  );
  const deviceId = crypto.randomUUID();
  const operations: string[] = [];
  const engine = await createAutomationEngine(
    {
      deviceId,
      call: async (command, input, id) => {
        if (command === "fixture.fail")
          throw new Error("Private provider detail");
        operations.push(id);
        return input as any;
      },
    },
    { kind: "sqlite", path: path.join(directory, "workflow.sqlite") },
  );
  const node = (id: string, type: any, config: any = {}) => ({
    id,
    type,
    config,
    position: { x: 0, y: 0 },
  });
  const graph = {
    nodes: [
      node("filter", "filter", { path: "/keep", equals: true }),
      node("loop", "foreach", {
        max_items: 3,
        graph: {
          nodes: [
            node("map", "map", { mapping: { title: "/name" } }),
            node("save", "command", { command: "fixture.save" }),
          ],
          edges: [{ id: "inner", source: "map", target: "save" }],
        },
      }),
      node("failure", "command", { command: "fixture.fail" }),
      node("recover", "transform", { value: "handled" }),
      node("join", "output"),
    ],
    edges: [
      { id: "a", source: "filter", target: "loop" },
      { id: "b", source: "loop", target: "join" },
      {
        id: "c",
        source: "failure",
        target: "recover",
        condition: "error" as const,
      },
      { id: "d", source: "recover", target: "join" },
    ],
  };
  try {
    await engine.worker.start();
    const execution = {
      id: crypto.randomUUID(),
      interpreterVersion: 2 as const,
      targetDeviceId: deviceId,
      allowTrustedCode: false,
      input: [
        { name: "one", keep: true },
        { name: "skip", keep: false },
        { name: "two", keep: true },
      ],
      graph,
    };
    const handle = await engine.run(execution);
    expect(await handle.result({ timeoutMs: 15000 })).toEqual({
      loop: [{ title: "one" }, { title: "two" }],
      recover: "handled",
    });
    expect(operations.length).toBe(2);
    expect(new Set(operations).size).toBe(2);
    expect(operations[0]).toContain("loop/0/save");
    expect((await engine.run(execution)).workflowRun.id).toBe(
      handle.workflowRun.id,
    );
  } finally {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
it("resumes a durable signal wait after its selected runner restarts", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "taskasaur-signal-")),
    deviceId = crypto.randomUUID();
  const host = { deviceId, call: async () => null },
    storage = {
      kind: "sqlite" as const,
      path: path.join(directory, "workflow.sqlite"),
    };
  let engine = await createAutomationEngine(host, storage);
  const execution = {
    id: crypto.randomUUID(),
    interpreterVersion: 2 as const,
    targetDeviceId: deviceId,
    allowTrustedCode: false,
    input: null,
    graph: {
      nodes: [
        {
          id: "approval",
          type: "signal" as const,
          position: { x: 0, y: 0 },
          config: { name: "approve", timeout_seconds: 60 },
        },
      ],
      edges: [],
    },
  };
  try {
    await engine.worker.start();
    const first = await engine.run(execution);
    await new Promise((r) => setTimeout(r, 500));
    await engine.stop();
    engine = await createAutomationEngine(host, storage);
    await engine.worker.start();
    const restored = await engine.run(execution);
    expect(restored.workflowRun.id).toBe(first.workflowRun.id);
    let delivered = false;
    for (let attempt = 0; attempt < 50 && !delivered; attempt++) {
      const result = await engine.engine.sendSignal({
        signal: execution.id + ":approve",
        data: { approved: true },
      });
      delivered = result.workflowRunIds.includes(restored.workflowRun.id);
      if (!delivered) await new Promise((r) => setTimeout(r, 100));
    }
    expect(delivered).toBe(true);
    expect(await restored.result({ timeoutMs: 15000 })).toEqual({
      approved: true,
    });
  } finally {
    await engine.stop();
    await rm(directory, { recursive: true, force: true });
  }
}, 25000);
