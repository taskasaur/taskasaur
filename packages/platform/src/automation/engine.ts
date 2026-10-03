import { interpretV1 } from "./automation-v1";
import { OpenWorkflow } from "openworkflow";
import { BackendSqlite } from "openworkflow/sqlite";
import type { OpenWorkflowOptions } from "openworkflow";
import {
  validateGraph,
  orderedNodes,
  inputPointer,
  type WorkflowGraph,
} from "../core/workflows";
import { CoreError, invariant } from "../core/errors";
import type { Value } from "../field-types";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { compileTypeScript } from "./typescript";
export type { WorkflowExecution, ExecutionHost } from "./graph";
import {
  interpretGraph,
  type WorkflowExecution,
  type ExecutionHost,
} from "./graph";
const runFile = promisify(execFile);
export async function runTypeScript(source: string, input: Value) {
  const compiled = compileTypeScript(source);
  const program = `${compiled}\nlet raw='';for await(const chunk of process.stdin)raw+=chunk;process.stdout.write(JSON.stringify(await main(JSON.parse(raw))) ?? 'null');`;
  // Trusted-author execution only. This is a resource boundary, not a hostile-code sandbox.
  return new Promise<Value>((resolve, reject) => {
    const child = execFile(
      process.execPath,
      ["--max-old-space-size=64", "--input-type=module", "-e", program],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "production",
          ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
        },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error)
          reject(new Error("TypeScript node failed or exceeded its limit"));
        else
          try {
            resolve(JSON.parse(stdout));
          } catch {
            reject(new Error("TypeScript node must return JSON"));
          }
      },
    );
    child.stdin?.end(JSON.stringify(input));
  });
}
export interface AutomationEngine {
  backend: OpenWorkflowOptions["backend"];
  engine: OpenWorkflow;
  worker: ReturnType<OpenWorkflow["newWorker"]>;
  run(execution: WorkflowExecution): ReturnType<OpenWorkflow["runWorkflow"]>;
  stop(): Promise<void>;
}
export async function createAutomationEngine(
  host: ExecutionHost,
  storage:
    | { kind: "sqlite"; path: string }
    | { kind: "provided"; backend: OpenWorkflowOptions["backend"] },
): Promise<AutomationEngine> {
  const backend =
    storage.kind === "sqlite"
      ? BackendSqlite.connect(storage.path, { namespaceId: host.deviceId })
      : storage.backend;
  const engine = new OpenWorkflow({ backend });
  const legacy = engine.defineWorkflow<WorkflowExecution, Value>(
    { name: "taskasaur.graph.v1" },
    ({ input, step }) => {
      invariant(
        input.targetDeviceId === host.deviceId,
        "WRONG_EXECUTION_TARGET",
        "Workflow belongs to another device",
      );
      return interpretV1(input, step, host);
    },
  );
  const workflow = engine.defineWorkflow<WorkflowExecution, Value>(
    { name: "taskasaur.graph.v2" },
    ({ input, step }) =>
      interpretGraph(input, step, {
        ...host,
        typescript: host.typescript ?? runTypeScript,
      }),
  );
  const worker = engine.newWorker({ concurrency: 2 });
  return {
    backend,
    engine,
    worker,
    run: async (execution: WorkflowExecution) => {
      validateGraph(execution.graph);
      invariant(
        execution.targetDeviceId === host.deviceId,
        "WRONG_EXECUTION_TARGET",
        "Never substitute another runner",
      );
      return (execution.interpreterVersion === 2 ? workflow : legacy).run(
        execution,
        { idempotencyKey: execution.id },
      );
    },
    stop: async () => {
      await worker.stop();
      await backend.stop();
    },
  };
}
