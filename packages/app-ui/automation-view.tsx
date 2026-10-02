"use client";
import { useCallback, useEffect, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  type Connection,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Play, Save, Plus, ArrowLeft } from "lucide-react";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "../plugin-sdk";
import { RecordTable } from "./record-table";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import {
  validateGraph,
  nodeSchemas,
  type WorkflowGraph,
} from "../core/workflows";
import { RecordForm, FieldInput } from "../ui/fields";
import { field, type Value } from "../field-types";
import { getSchema } from "../core/catalog";
export default function AutomationView({ runtime }: { runtime: AppRuntime }) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null),
    [run, setRun] = useState<ResourceRecord | null>(null),
    [notice, setNotice] = useState("");
  return selected ? (
    <WorkflowEditor
      runtime={runtime}
      record={selected}
      onBack={() => setSelected(null)}
    />
  ) : (
    <div className="space-y-6">
      <p className="page-description">
        Build TypeScript workflows, then choose the exact device that runs them.
        The selected runner owns execution even when this window closes.
      </p>
      <RecordTable
        runtime={runtime}
        collection="workflows"
        onOpen={setSelected}
      />
      <h2 className="font-semibold">Run history</h2>
      <RecordTable
        runtime={runtime}
        collection="workflow_runs"
        readOnly
        onOpen={setRun}
      />
      {run && (
        <section className="space-y-3 border rounded-xl p-4">
          <h3>Selected run · {String(run.data.status)}</h3>
          <Button
            variant="outline"
            onClick={() =>
              void runtime
                .api("automation/cancel", { id: run.id })
                .then(() =>
                  setNotice("Cancellation requested on the selected device."),
                )
                .catch((error) => setNotice(error.message))
            }
          >
            Cancel run
          </Button>
          <RecordForm
            schema={{
              id: "workflow_signal",
              pluginId: "automation-runtime",
              name: "Resume with a signal",
              version: 1,
              fields: [
                field("name", "Signal name", "text", {
                  required: true,
                  nullable: false,
                }),
                field("data", "Signal data", "jsonb", { default: {} }),
              ],
            }}
            onCancel={() => setRun(null)}
            onSave={async (values) => {
              await runtime.api("automation/signal", {
                id: run.id,
                ...values,
                operationId: crypto.randomUUID(),
              });
              setNotice("Signal queued for this run.");
            }}
          />
          {notice && <p role="status">{notice}</p>}
        </section>
      )}
    </div>
  );
}
function WorkflowEditor({
  runtime,
  record: initial,
  onBack,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
  onBack: () => void;
}) {
  const [record, setRecord] = useState(initial),
    [name, setName] = useState(String(initial.data.name)),
    [target, setTarget] = useState(String(initial.data.target_device_id ?? "")),
    [error, setError] = useState(""),
    [selection, setSelection] = useState<string | null>(null),
    [configuration, setConfiguration] = useState("{}"),
    [edgeSelection, setEdgeSelection] = useState<string | null>(null),
    [hook, setHook] = useState<{ path: string; token: string } | null>(null);
  const graph = initial.data.graph as unknown as WorkflowGraph;
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(
    (graph.nodes ?? []).map((n) => ({
      id: n.id,
      position: n.position ?? { x: 0, y: 0 },
      data: { label: n.type, kind: n.type, config: n.config },
    })),
  );
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(
    (graph.edges ?? []).map((e) => ({
      ...e,
      data: { condition: e.condition },
    })),
  );
  const devices =
    useLiveQuery(() => runtime.collection("devices").list(), [runtime]) ?? [];
  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((current) => addEdge(connection, current)),
    [setEdges],
  );
  const eligible = devices.filter(
    (d) =>
      Array.isArray(d.data.capabilities) &&
      d.data.capabilities.includes("automation.execute"),
  );
  async function save(publish = false) {
    const next = validateGraph({
      nodes: nodes.map((n) => ({
        id: n.id,
        type: n.data.kind,
        position: n.position,
        config: n.data.config,
      })),
      edges: edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        condition: e.data?.condition ?? "always",
      })),
    });
    if (publish && !target)
      throw new Error("Choose the device that will run this workflow");
    const updated = await runtime.collection("workflows").put(
      {
        ...record.data,
        name,
        graph: next as unknown as Value,
        target_device_id: target || null,
        published_version: publish
          ? Number(record.data.published_version ?? 0) + 1
          : record.data.published_version,
      },
      record.id,
    );
    setRecord(updated);
    return updated;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          Workflows
        </Button>
        <Input
          aria-label="Workflow name"
          className="max-w-60"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="flex items-center gap-2 text-sm">
          Run on
          <select
            aria-label="Run on device"
            className="core-select w-52"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose device</option>
            {eligible.map((d) => (
              <option key={d.id} value={d.id}>
                {String(d.data.name)}
                {Date.now() - Date.parse(String(d.data.last_seen)) > 45000
                  ? " (offline)"
                  : ""}
              </option>
            ))}
          </select>
        </label>
        <Button
          variant="outline"
          onClick={() =>
            void save()
              .then(() => setError(""))
              .catch((e) => setError(e.message))
          }
        >
          <Save size={14} />
          Save
        </Button>
        <Button
          disabled={!runtime.profile.connected || !target}
          onClick={async () => {
            try {
              const saved = await save(true);
              await runtime.synchronize();
              await runtime.api("automation/run", {
                id: saved.id,
                targetDeviceId: target,
                operationId: crypto.randomUUID(),
              });
              setError("Run queued on the selected device.");
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          <Play size={14} />
          Publish and run
        </Button>
      </div>
      <details className="border rounded-xl p-4">
        <summary>Trigger and execution settings</summary>
        <RecordForm
          schema={{
            ...getSchema("workflows"),
            fields: getSchema("workflows").fields.filter(
              (f) =>
                ![
                  "name",
                  "graph",
                  "target_device_id",
                  "published_version",
                ].includes(f.id),
            ),
          }}
          initial={Object.fromEntries(
            Object.entries(record.data).filter(
              ([key]) =>
                ![
                  "name",
                  "graph",
                  "target_device_id",
                  "published_version",
                ].includes(key),
            ),
          )}
          onCancel={() => undefined}
          onSave={async (values) => {
            const updated = await runtime
              .collection("workflows")
              .put({ ...record.data, ...values }, record.id);
            setRecord(updated);
            setError("Workflow settings saved.");
          }}
        />
        {record.data.trigger_kind === "webhook" && (
          <div className="space-y-2">
            <Button
              disabled={!runtime.profile.connected}
              onClick={() =>
                void runtime
                  .synchronize()
                  .then(() =>
                    runtime.api<{ path: string; token: string }>(
                      "automation/webhook",
                      { id: record.id },
                    ),
                  )
                  .then(setHook)
                  .catch((e) => setError(e.message))
              }
            >
              Create or rotate webhook credential
            </Button>
            {hook && (
              <p className="text-sm break-all">
                POST{" "}
                {
                  new URL(
                    hook.path,
                    runtime.profile.serverUrl || location.origin,
                  ).href
                }{" "}
                · Authorization: Bearer {hook.token} · Include an
                Idempotency-Key header. This credential is shown only here.
              </p>
            )}
          </div>
        )}
      </details>
      {error && (
        <p className="notice" role="status">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {Object.keys(nodeSchemas).map((kind) => (
          <Button
            key={kind}
            variant="outline"
            size="sm"
            onClick={() =>
              setNodes((current) => [
                ...current,
                {
                  id: crypto.randomUUID(),
                  position: {
                    x: 80 + current.length * 35,
                    y: 60 + current.length * 65,
                  },
                  data: {
                    label: kind,
                    kind,
                    config:
                      kind === "wait"
                        ? { seconds: 10 }
                        : kind === "typescript"
                          ? { language: "typescript", source: "return input;" }
                          : kind === "http"
                            ? { url: "https://example.com" }
                            : {},
                  },
                },
              ])
            }
          >
            <Plus size={12} />
            {kind}
          </Button>
        ))}
      </div>
      <div className="grid lg:grid-cols-[1fr_280px] gap-4">
        <div className="h-[580px] border rounded-xl overflow-hidden">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            onNodeClick={(_, node) => {
              setEdgeSelection(null);
              setSelection(node.id);
              setConfiguration(JSON.stringify(node.data.config, null, 2));
            }}
            onEdgeClick={(_, edge) => {
              setSelection(null);
              setEdgeSelection(edge.id);
            }}
          >
            <Background />
            <Controls />
            <MiniMap />
          </ReactFlow>
        </div>
        <aside className="border rounded-xl p-4">
          <h3 className="font-medium mb-3">Node configuration</h3>
          {edgeSelection ? (
            <div className="space-y-3">
              <FieldInput
                definition={field(
                  "condition",
                  "Follow this connection",
                  "text",
                  { choices: ["always", "true", "false", "success", "error"] },
                )}
                value={String(
                  edges.find((e) => e.id === edgeSelection)?.data?.condition ??
                    "always",
                )}
                onChange={(condition) =>
                  setEdges((current) =>
                    current.map((edge) =>
                      edge.id === edgeSelection
                        ? {
                            ...edge,
                            label: String(condition),
                            data: { ...edge.data, condition },
                          }
                        : edge,
                    ),
                  )
                }
              />
              <Button
                variant="outline"
                onClick={() => {
                  setEdges((current) =>
                    current.filter((edge) => edge.id !== edgeSelection),
                  );
                  setEdgeSelection(null);
                }}
              >
                Remove connection
              </Button>
            </div>
          ) : selection ? (
            <>
              <RecordForm
                key={selection}
                schema={
                  nodeSchemas[
                    String(nodes.find((n) => n.id === selection)?.data.kind)
                  ]
                }
                initial={
                  nodes.find((n) => n.id === selection)?.data.config as Record<
                    string,
                    Value
                  >
                }
                onCancel={() => setSelection(null)}
                onSave={async (config) => {
                  setNodes((current) =>
                    current.map((n) =>
                      n.id === selection
                        ? { ...n, data: { ...n.data, config } }
                        : n,
                    ),
                  );
                  setError("");
                }}
              />
              <p className="text-xs text-muted-foreground mt-4">
                Code nodes use TypeScript and require trusted-author permission.
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a node to edit its typed configuration.
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
