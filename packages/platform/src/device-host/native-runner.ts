import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { HostConfig } from "./native-host";
import { createAutomationEngine } from "../automation/engine";
import type { Dispatch } from "../plugin-sdk/device";
import type { Value } from "../field-types";
export async function startNativeRunner(
  config: HostConfig,
  directory: string,
  lease: () => number | undefined,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const receipts = new DatabaseSync(path.join(directory, "receipts.sqlite"));
  receipts.exec(
    "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,engine_run_id TEXT NOT NULL)",
  );
  let stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  const api = async <T>(action: string, body: unknown): Promise<T> => {
    const epoch = lease();
    if (epoch == null) throw new Error("Core device connection is unavailable");
    const response = await fetch(
      new URL("/api/devices/runs/" + action, config.serverUrl),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + config.token,
          "X-Taskasaur-Device": config.deviceId,
          "X-Taskasaur-Lease": String(epoch),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      },
    );
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error?.message ?? "Core run request failed");
    return result as T;
  };
  const engine = await createAutomationEngine(
    {
      deviceId: config.deviceId,
      call: (command, input, operationId) =>
        api<Value>("command", {
          runId: operationId.split(":")[0],
          command,
          input,
          operationId,
        }),
    },
    { kind: "sqlite", path: path.join(directory, "workflows.sqlite") },
  );
  await engine.worker.start();
  const tick = async () => {
    try {
      const dispatches = await api<Dispatch[]>("poll", {});
      for (const dispatch of dispatches) {
        if (stopped) break;
        let engineId = (
          receipts
            .prepare("SELECT engine_run_id FROM runs WHERE run_id=?")
            .get(dispatch.run_id) as { engine_run_id: string } | undefined
        )?.engine_run_id;
        if (!engineId) {
          const handle = await engine.run(dispatch.execution);
          engineId = handle.workflowRun.id;
          receipts
            .prepare(
              "INSERT OR IGNORE INTO runs(run_id,engine_run_id) VALUES(?,?)",
            )
            .run(dispatch.run_id, engineId);
        }
        if (dispatch.status === "queued")
          await api("report", {
            runId: dispatch.run_id,
            assignmentEpoch: String(dispatch.assignment_epoch),
            status: "accepted",
            engineRunId: engineId,
            output: null,
          });
        if (dispatch.cancel_requested)
          await engine.engine
            .cancelWorkflowRun(engineId)
            .catch(() => undefined);
        for (const signal of dispatch.signals ?? []) {
          const delivered = await engine.engine.sendSignal({
            signal: dispatch.run_id + ":" + signal.name,
            data: signal.data,
          });
          if (delivered.workflowRunIds.includes(engineId))
            await api("signal-ack", { runId: dispatch.run_id, id: signal.id });
        }
        const run = await engine.backend.getWorkflowRun({
          workflowRunId: engineId,
        });
        if (
          run &&
          ["completed", "succeeded", "failed", "canceled"].includes(run.status)
        )
          await api("report", {
            runId: dispatch.run_id,
            assignmentEpoch: String(dispatch.assignment_epoch),
            engineRunId: engineId,
            status:
              run.status === "canceled"
                ? "cancelled"
                : run.status === "failed"
                  ? "failed"
                  : "completed",
            output: run.output,
          });
      }
    } catch {
      /* Reconnect preserves checkpoints and the original target. */
    } finally {
      if (!stopped) timer = setTimeout(tick, 3000);
    }
  };
  void tick();
  return {
    close: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await engine.stop();
      receipts.close();
    },
  };
}
