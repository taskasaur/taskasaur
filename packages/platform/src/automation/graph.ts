import {
  validateGraph,
  orderedNodes,
  inputPointer,
  type WorkflowGraph,
} from "../core/workflows";
import { CoreError, invariant } from "../core/errors";
import type { Value } from "../field-types";
export interface WorkflowExecution {
  id: string;
  interpreterVersion?: 1 | 2;
  targetDeviceId: string;
  graph: WorkflowGraph;
  input: Value;
  allowTrustedCode: boolean;
}
export interface ExecutionHost {
  deviceId: string;
  canRun?(execution: WorkflowExecution): Promise<boolean>;
  call(command: string, input: unknown, operationId: string): Promise<Value>;
  http?(url: string, init: RequestInit): Promise<Value>;
  typescript?(source: string, input: Value): Promise<Value>;
}
export interface GraphSteps {
  run<T>(
    options: { name: string; retryPolicy: { maximumAttempts: number } },
    work: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
  waitForSignal<T>(options: {
    name: string;
    signal: string;
    timeout: number;
  }): Promise<{ data: T } | null>;
}
export async function interpretGraph(
  execution: WorkflowExecution,
  step: GraphSteps,
  host: ExecutionHost,
): Promise<Value> {
  invariant(
    execution.targetDeviceId === host.deviceId,
    "WRONG_EXECUTION_TARGET",
    "Workflow is assigned to another device",
  );
  let executed = 0;
  const runGraph = async (
    graph: WorkflowGraph,
    initial: Value,
    prefix: string,
  ): Promise<Value> => {
    const outputs: Record<string, Value> = {},
      skipped = new Set<string>(),
      failed = new Set<string>(),
      done = new Set<string>();
    const ordered = orderedNodes(graph);
    const execute = async (node: WorkflowGraph["nodes"][number]) => {
      invariant(
        ++executed <= 10000,
        "WORKFLOW_LIMIT",
        "Workflow exceeds 10,000 node executions",
      );
      const name = prefix + node.id;
      let pause = 0;
      while (host.canRun && !(await host.canRun(execution)))
        await step.sleep(`${name}:execution-paused:${pause++}`, "5s");
      const incoming = graph.edges.filter((e) => e.target === node.id);
      const active = incoming.filter(
        (edge) =>
          !skipped.has(edge.source) &&
          (edge.condition === "error"
            ? failed.has(edge.source)
            : !failed.has(edge.source) &&
              (edge.condition === "true"
                ? Boolean(outputs[edge.source])
                : edge.condition === "false"
                  ? !outputs[edge.source]
                  : true)),
      );
      if (incoming.length && !active.length) {
        skipped.add(node.id);
        return;
      }
      const input: Value =
        active.length === 1
          ? outputs[active[0].source]
          : active.length > 1
            ? Object.fromEntries(
                active.map((e) => [e.source, outputs[e.source]]),
              )
            : initial;
      if (node.type === "wait") {
        await step.sleep(name, `${Number(node.config.seconds)}s`);
        outputs[node.id] = input;
        return;
      }
      if (node.type === "signal") {
        const received = await step.waitForSignal<Value>({
          name,
          signal: execution.id + ":" + String(node.config.name),
          timeout: Number(node.config.timeout_seconds) * 1000,
        });
        outputs[node.id] = received ? received.data : { timedOut: true };
        return;
      }
      if (node.type === "subflow") {
        outputs[node.id] = await runGraph(
          node.config.graph as WorkflowGraph,
          input,
          name + "/",
        );
        return;
      }
      if (node.type === "foreach") {
        invariant(
          Array.isArray(input) && input.length <= Number(node.config.max_items),
          "VALIDATION_FAILED",
          "Loop input must be an array within its item limit",
        );
        const values: Value[] = [];
        for (let i = 0; i < input.length; i++)
          values.push(
            await runGraph(
              node.config.graph as WorkflowGraph,
              input[i],
              name + "/" + i + "/",
            ),
          );
        outputs[node.id] = values;
        return;
      }
      const errorRoute = graph.edges.some(
        (e) => e.source === node.id && e.condition === "error",
      );
      const outcome = await step.run(
        {
          name,
          retryPolicy: {
            maximumAttempts:
              node.type === "http" || node.type === "typescript" || errorRoute
                ? 1
                : 3,
          },
        },
        async (): Promise<{ value: Value; failed: boolean }> => {
          try {
            let value: Value;
            switch (node.type) {
              case "input":
              case "output":
                value = input;
                break;
              case "transform":
                value = (node.config.value ?? input) as Value;
                break;
              case "map":
                value = Object.fromEntries(
                  Object.entries(
                    node.config.mapping as Record<string, string>,
                  ).map(([key, pointer]) => [
                    key,
                    inputPointer(input, pointer) ?? null,
                  ]),
                ) as Value;
                break;
              case "filter":
                invariant(
                  Array.isArray(input),
                  "VALIDATION_FAILED",
                  "Filter input must be an array",
                );
                value = input.filter(
                  (item) =>
                    JSON.stringify(
                      inputPointer(item, String(node.config.path ?? "")),
                    ) === JSON.stringify(node.config.equals),
                );
                break;
              case "condition":
                value =
                  JSON.stringify(input) === JSON.stringify(node.config.equals);
                break;
              case "command":
                value = await host.call(
                  String(node.config.command),
                  node.config.input ?? input,
                  execution.id + ":" + name,
                );
                break;
              case "http": {
                const request = {
                  method: String(node.config.method ?? "GET"),
                  headers: { "Content-Type": "application/json" },
                  ...(node.config.body != null
                    ? { body: JSON.stringify(node.config.body) }
                    : {}),
                };
                if (host.http) {
                  value = await host.http(String(node.config.url), request);
                  break;
                }
                const response = await fetch(String(node.config.url), {
                  ...request,
                  signal: AbortSignal.timeout(15000),
                  redirect: "error",
                });
                invariant(
                  response.ok,
                  "HTTP_ERROR",
                  `HTTP request returned ${response.status}`,
                );
                invariant(
                  Number(response.headers.get("content-length") ?? 0) <=
                    1024 * 1024,
                  "PAYLOAD_TOO_LARGE",
                  "HTTP response exceeds 1 MB",
                );
                const body = await response.text();
                invariant(
                  body.length <= 1024 * 1024,
                  "PAYLOAD_TOO_LARGE",
                  "HTTP response exceeds 1 MB",
                );
                value = JSON.parse(body) as Value;
                break;
              }
              case "typescript":
                invariant(
                  execution.allowTrustedCode && host.typescript,
                  "PERMISSION_DENIED",
                  "Trusted code execution must be explicitly enabled",
                );
                value = await host.typescript!(
                  String(node.config.source ?? ""),
                  input,
                );
                break;
              default:
                throw new Error("Unsupported node");
            }
            return { value, failed: false };
          } catch (error) {
            if (!errorRoute) throw error;
            return {
              value: {
                error: {
                  kind: error instanceof CoreError ? error.kind : "NODE_FAILED",
                  message: "Node failed; inspect the operation configuration",
                },
              },
              failed: true,
            };
          }
        },
      );
      outputs[node.id] = outcome.value;
      if (outcome.failed) failed.add(node.id);
    };
    // Deterministic levels and joins; at most four independent steps execute at once.
    while (done.size < graph.nodes.length) {
      const ready = ordered.filter(
        (node) =>
          !done.has(node.id) &&
          graph.edges
            .filter((e) => e.target === node.id)
            .every((e) => done.has(e.source)),
      );
      for (let i = 0; i < ready.length; i += 4) {
        const group = ready.slice(i, i + 4);
        await Promise.all(group.map(execute));
        group.forEach((node) => done.add(node.id));
      }
    }
    const terminals = ordered.filter(
      (node) =>
        !skipped.has(node.id) && !graph.edges.some((e) => e.source === node.id),
    );
    return terminals.length === 1
      ? outputs[terminals[0].id]
      : Object.fromEntries(
          terminals.map((node) => [node.id, outputs[node.id]]),
        );
  };
  return runGraph(validateGraph(execution.graph), execution.input, "");
}
