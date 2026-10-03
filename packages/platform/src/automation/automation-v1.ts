// Retained checkpoint format for runs assigned before interpreter v2.
import type { defineWorkflow } from "openworkflow";
type StepApi = Parameters<Parameters<typeof defineWorkflow>[1]>[0]["step"];
import type { WorkflowExecution, ExecutionHost } from "./engine";
import { runTypeScript } from "./engine";
import { validateGraph, orderedNodes } from "../core/workflows";
import { invariant } from "../core/errors";
import type { Value } from "../field-types";
export async function interpretV1(
  execution: WorkflowExecution,
  step: StepApi,
  host: ExecutionHost,
): Promise<Value> {
  const graph = validateGraph(execution.graph),
    outputs: Record<string, Value> = {},
    skipped = new Set<string>();
  let result: Value = execution.input;
  for (const node of orderedNodes(graph)) {
    let pause = 0;
    while (host.canRun && !(await host.canRun(execution)))
      await step.sleep(`${node.id}:execution-paused:${pause++}`, "5s");
    const incoming = graph.edges.filter((e) => e.target === node.id);
    const active = incoming.filter(
      (edge) =>
        !skipped.has(edge.source) &&
        (edge.condition === "true"
          ? Boolean(outputs[edge.source])
          : edge.condition === "false"
            ? !outputs[edge.source]
            : true),
    );
    if (incoming.length && !active.length) {
      skipped.add(node.id);
      continue;
    }
    const input =
      active.length === 1
        ? outputs[active[0].source]
        : active.length > 1
          ? Object.fromEntries(active.map((e) => [e.source, outputs[e.source]]))
          : execution.input;
    if (node.type === "wait") {
      await step.sleep(node.id, `${Number(node.config.seconds)}s`);
      outputs[node.id] = input;
      continue;
    }
    outputs[node.id] = await step.run(
      {
        name: node.id,
        retryPolicy: {
          maximumAttempts:
            node.type === "http" || node.type === "typescript" ? 1 : 3,
        },
      },
      async () => {
        switch (node.type) {
          case "input":
          case "output":
            return input;
          case "transform":
            return (node.config.value ?? input) as Value;
          case "condition":
            return JSON.stringify(input) === JSON.stringify(node.config.equals);
          case "command":
            return host.call(
              String(node.config.command),
              node.config.input ?? input,
              `${execution.id}:${node.id}`,
            );
          case "http": {
            const request = {
              method: String(node.config.method ?? "GET"),
              headers: { "Content-Type": "application/json" },
              ...(node.config.body != null
                ? { body: JSON.stringify(node.config.body) }
                : {}),
            };
            if (host.http) return host.http(String(node.config.url), request);
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
            return (await response.json()) as Value;
          }
          case "typescript":
            invariant(
              execution.allowTrustedCode,
              "PERMISSION_DENIED",
              "Trusted code execution must be explicitly enabled",
            );
            return runTypeScript(String(node.config.source ?? ""), input);
          default:
            throw new Error("Unsupported node");
        }
      },
    );
    result = outputs[node.id];
  }
  return result;
}
