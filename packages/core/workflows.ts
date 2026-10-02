import { z } from "zod";
import { invariant } from "./errors";
import { field, validateRecord, type RecordSchema } from "../field-types";
const required = { required: true, nullable: false };
export const nodeSchemas: Record<string, RecordSchema> = Object.fromEntries(
  Object.entries({
    input: [],
    output: [],
    transform: [field("value", "Value", "jsonb", { default: null })],
    map: [
      field("mapping", "Output fields to input JSON pointers", "jsonb", {
        ...required,
        default: {},
      }),
    ],
    filter: [
      field("path", "Item JSON pointer", "text", { default: "" }),
      field("equals", "Equals", "jsonb", { default: null }),
    ],
    foreach: [
      field("graph", "Loop body graph", "jsonb", required),
      field("max_items", "Maximum items", "integer", {
        ...required,
        default: 100,
        min: 1,
        max: 1000,
      }),
    ],
    subflow: [field("graph", "Pinned subflow graph", "jsonb", required)],
    signal: [
      field("name", "Signal name", "text", required),
      field("timeout_seconds", "Timeout seconds", "integer", {
        ...required,
        default: 3600,
        min: 1,
        max: 604800,
      }),
    ],
    condition: [field("equals", "Equals", "jsonb", { default: null })],
    wait: [
      field("seconds", "Seconds", "integer", {
        ...required,
        min: 1,
        max: 86400,
        default: 10,
      }),
    ],
    command: [
      field("command", "Core command", "text", required),
      field("input", "Input", "jsonb"),
    ],
    http: [
      field("url", "URL", "text", { ...required, control: "url" }),
      field("method", "Method", "text", {
        ...required,
        choices: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        default: "GET",
      }),
      field("body", "Body", "jsonb"),
    ],
    typescript: [
      field("language", "Language", "text", {
        ...required,
        choices: ["typescript"],
        default: "typescript",
      }),
      field("source", "TypeScript", "text", {
        ...required,
        control: "textarea",
        default: "return input;",
      }),
    ],
  }).map(([id, fields]) => [
    id,
    { id, pluginId: "automation-runtime", name: id, version: 1, fields },
  ]),
);
export const workflowNode = z.object({
  id: z.string().min(1),
  type: z.enum([
    "input",
    "transform",
    "condition",
    "wait",
    "command",
    "http",
    "typescript",
    "output",
    "map",
    "filter",
    "foreach",
    "subflow",
    "signal",
  ]),
  position: z.object({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 }),
  config: z.record(z.unknown()).default({}),
});
export const graphSchema = z.object({
  nodes: z.array(workflowNode).min(1).max(256),
  edges: z
    .array(
      z.object({
        id: z.string(),
        source: z.string(),
        target: z.string(),
        condition: z
          .enum(["true", "false", "always", "success", "error"])
          .optional(),
      }),
    )
    .max(512),
});
export type WorkflowGraph = z.infer<typeof graphSchema>;
export function validateGraph(input: unknown, depth = 0): WorkflowGraph {
  invariant(
    depth <= 4,
    "VALIDATION_FAILED",
    "Subflows may be nested at most four levels",
  );
  const graph = graphSchema.parse(input),
    ids = new Set(graph.nodes.map((n) => n.id));
  invariant(
    ids.size === graph.nodes.length,
    "VALIDATION_FAILED",
    "Node IDs must be unique",
  );
  const incoming = new Map(graph.nodes.map((n) => [n.id, 0])),
    outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    invariant(
      ids.has(edge.source) && ids.has(edge.target),
      "VALIDATION_FAILED",
      "Edge refers to an unknown node",
    );
    incoming.set(edge.target, incoming.get(edge.target)! + 1);
    outgoing.set(edge.source, [
      ...(outgoing.get(edge.source) ?? []),
      edge.target,
    ]);
  }
  const queue = [...incoming].filter(([, count]) => !count).map(([id]) => id);
  let count = 0;
  while (queue.length) {
    const id = queue.shift()!;
    count++;
    for (const next of outgoing.get(id) ?? []) {
      incoming.set(next, incoming.get(next)! - 1);
      if (!incoming.get(next)) queue.push(next);
    }
  }
  invariant(
    count === graph.nodes.length,
    "VALIDATION_FAILED",
    "Workflow contains a cycle",
  );
  for (const node of graph.nodes) {
    node.config = validateRecord(nodeSchemas[node.type], node.config);
    if (node.type === "foreach" || node.type === "subflow")
      node.config.graph = validateGraph(node.config.graph, depth + 1);
    if (node.type === "map")
      invariant(
        node.config.mapping &&
          typeof node.config.mapping === "object" &&
          !Array.isArray(node.config.mapping) &&
          Object.values(node.config.mapping).every(
            (v) => typeof v === "string" && (v === "" || v.startsWith("/")),
          ),
        "VALIDATION_FAILED",
        "Mapping values must be JSON pointers into the input",
      );
    if (node.type === "signal")
      invariant(
        /^[a-zA-Z0-9._-]{1,80}$/.test(String(node.config.name)),
        "VALIDATION_FAILED",
        "Signal name must contain letters, digits, dots, underscores or hyphens",
      );
    if (node.type === "wait")
      invariant(
        Number.isInteger(node.config.seconds) &&
          Number(node.config.seconds) >= 1 &&
          Number(node.config.seconds) <= 86400,
        "VALIDATION_FAILED",
        "Wait must be 1–86400 seconds",
      );
    if (node.type === "typescript")
      invariant(
        node.config.language === undefined ||
          node.config.language === "typescript",
        "UNSUPPORTED_LANGUAGE",
        "Only TypeScript code nodes are supported",
      );
    if (node.type === "http") {
      const url = new URL(String(node.config.url));
      invariant(
        url.protocol === "https:" || url.protocol === "http:",
        "VALIDATION_FAILED",
        "HTTP node needs an HTTP(S) URL",
      );
    }
  }
  return graph;
}
export function allNodes(graph: WorkflowGraph): WorkflowGraph["nodes"] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(["foreach", "subflow"].includes(node.type)
      ? allNodes(node.config.graph as WorkflowGraph)
      : []),
  ]);
}
export function inputPointer(input: unknown, pointer: string): unknown {
  if (!pointer) return input;
  invariant(
    pointer.startsWith("/"),
    "VALIDATION_FAILED",
    "Use a JSON pointer beginning with / or an empty pointer for the whole input",
  );
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>((value, part) => {
      const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
      return value !== null &&
        typeof value === "object" &&
        Object.hasOwn(value, key)
        ? (value as Record<string, unknown>)[key]
        : null;
    }, input);
}
export function orderedNodes(graph: WorkflowGraph) {
  const done = new Set<string>(),
    ordered: WorkflowGraph["nodes"] = [];
  while (done.size < graph.nodes.length) {
    const next = graph.nodes.find(
      (n) =>
        !done.has(n.id) &&
        graph.edges
          .filter((e) => e.target === n.id)
          .every((e) => done.has(e.source)),
    );
    invariant(next, "VALIDATION_FAILED", "Workflow cannot be ordered");
    ordered.push(next);
    done.add(next.id);
  }
  return ordered;
}
