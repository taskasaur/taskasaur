import {
  interpretGraph,
  type GraphSteps,
  type WorkflowExecution,
  type ExecutionHost,
} from "@taskasaur/platform/automation/graph";
import { validateGraph, allNodes } from "@taskasaur/platform/core/workflows";
import { invariant } from "@taskasaur/platform/core/errors";
import type { Value } from "@taskasaur/platform/field-types";
import type { WorkspaceNode } from "./device";
import { LocalState } from "./local-state";
import { deviceRecordId } from "./records";
import { canonical } from "./crypto";
interface Checkpoint {
  status: "started" | "complete" | "waiting";
  value?: unknown;
  until?: number;
}
interface RunState {
  execution: WorkflowExecution;
  workflowId: string;
  version: number;
  steps: Record<string, Checkpoint>;
  signals: Record<string, Value>;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  output?: Value;
  error?: string;
}
class Suspended extends Error {}
/** Browser/mobile adapter for the same graph interpreter used by OpenWorkflow on native peers. */
export class PortableWorkflows {
  private store: LocalState;
  private active = new Map<string, Promise<void>>();
  constructor(
    readonly node: WorkspaceNode,
    readonly host: ExecutionHost,
    readonly allowed: () => { enabled: boolean; trustedCode: boolean },
  ) {
    this.store = new LocalState(node.replica, "workflow-checkpoints");
  }
  async start(input: {
    id: string;
    targetDeviceId: string;
    operationId?: string;
    input?: Value;
  }) {
    invariant(
      this.allowed().enabled,
      "CAPABILITY_UNSUPPORTED",
      "Automation execution is disabled on this device",
    );
    invariant(
      input.targetDeviceId === this.host.deviceId,
      "WRONG_EXECUTION_TARGET",
      "Choose this device explicitly",
    );
    const workflow = this.node.records.get(input.id);
    invariant(
      workflow?.collection === "workflows" && !workflow.deletedAt,
      "NOT_FOUND",
      "Workflow not found",
    );
    const version = Number(workflow.data.published_version),
      pin = this.node.replica.read<{ graph: unknown; trusted: boolean }>(
        "setting/workflow." + input.id + "." + version,
      );
    invariant(
      pin,
      "WORKFLOW_UNPUBLISHED",
      "Publish and synchronize the workflow first",
    );
    invariant(
      !pin.trusted ||
        (this.allowed().trustedCode &&
          workflow.data.allow_trusted_code === true),
      "PERMISSION_DENIED",
      "Trusted TypeScript is disabled on this device",
    );
    const id = input.operationId ?? crypto.randomUUID(),
      execution: WorkflowExecution = {
        id,
        interpreterVersion: 2,
        targetDeviceId: input.targetDeviceId,
        graph: validateGraph(pin.graph),
        input: input.input ?? {},
        allowTrustedCode: pin.trusted,
      };
    const previous = await this.store.get<RunState>(id);
    if (previous) {
      invariant(
        canonical(previous.execution) === canonical(execution),
        "IDEMPOTENCY_CONFLICT",
        "Run ID was reused",
      );
      return this.node.records.get(id);
    }
    const state: RunState = {
      execution,
      workflowId: workflow.id,
      version,
      steps: {},
      signals: {},
      status: "running",
    };
    await this.store.set(id, state);
    await this.publish(state);
    void this.run(id).catch((error) => {
      this.node.replica.error = String(error);
    });
    return this.node.records.get(id);
  }
  private async publish(state: RunState) {
    const old = this.node.records.get(state.execution.id);
    await this.node.records.put(
      "workflow_runs",
      {
        ...old?.data,
        workflow_id: state.workflowId,
        target_device_id: this.host.deviceId,
        workflow_version: state.version,
        status: state.status === "waiting" ? "waiting" : state.status,
        input: state.execution.input,
        output: state.output ?? null,
        error: state.error ?? null,
        ...(["completed", "failed", "cancelled"].includes(state.status)
          ? { ended_at: new Date().toISOString() }
          : {}),
      },
      state.execution.id,
    );
  }
  async run(id: string): Promise<void> {
    if (this.active.has(id)) return this.active.get(id);
    const task = this.advance(id).finally(() => {
      this.active.delete(id);
    });
    this.active.set(id, task);
    return task;
  }
  private async advance(id: string) {
    const state = await this.store.get<RunState>(id);
    if (
      !state ||
      !["running", "waiting"].includes(state.status) ||
      !this.allowed().enabled
    )
      return;
    const pending = new Set<Promise<unknown>>();
    let writes = Promise.resolve();
    const save = () => {
      writes = writes.then(async () => {
        await this.store.update<RunState>(id, (current) => {
          if (current?.status === "cancelled") state.status = "cancelled";
          if (current) state.signals = current.signals;
          return state;
        });
      });
      return writes;
    };
    const check = async () => {
      invariant(
        this.allowed().enabled,
        "CAPABILITY_UNSUPPORTED",
        "Automation execution was disabled",
      );
      const current = await this.store.get<RunState>(id);
      invariant(
        current?.status !== "cancelled",
        "CANCELLED",
        "Run was cancelled",
      );
      if (current) state.signals = current.signals;
    };
    const steps: GraphSteps = {
      run: async <T>(
        { name }: { name: string; retryPolicy: { maximumAttempts: number } },
        work: () => Promise<T>,
      ) => {
        await check();
        const prior = state.steps[name];
        if (prior?.status === "complete") return prior.value as T;
        invariant(
          prior?.status !== "started",
          "OPERATION_UNCERTAIN",
          "An interrupted step may have completed outside Taskasaur. Review it before starting a new run.",
        );
        state.steps[name] = { status: "started" };
        await save();
        const task = work();
        pending.add(task);
        try {
          const result = await task;
          state.steps[name] = { status: "complete", value: result };
          await save();
          return result;
        } finally {
          pending.delete(task);
        }
      },
      sleep: async (name, duration) => {
        await check();
        const prior = state.steps[name],
          until = prior?.until ?? Date.now() + parseFloat(duration) * 1000;
        if (prior?.status === "complete") return;
        if (until > Date.now()) {
          state.steps[name] = { status: "waiting", until };
          await save();
          throw new Suspended();
        }
        state.steps[name] = { status: "complete" };
        await save();
      },
      waitForSignal: async <T>({
        name,
        signal,
        timeout,
      }: {
        name: string;
        signal: string;
        timeout: number;
      }) => {
        await check();
        const prior = state.steps[name];
        if (prior?.status === "complete")
          return prior.value as { data: T } | null;
        const until = prior?.until ?? Date.now() + timeout;
        const value = Object.hasOwn(state.signals, signal)
          ? { data: state.signals[signal] as T }
          : null;
        if (!value && until > Date.now()) {
          state.steps[name] = { status: "waiting", until };
          await save();
          throw new Suspended();
        }
        state.steps[name] = { status: "complete", value };
        await save();
        return value;
      },
    };
    try {
      state.output = await interpretGraph(state.execution, steps, this.host);
      state.status = "completed";
    } catch (error) {
      await Promise.allSettled(pending);
      state.status =
        error instanceof Suspended
          ? "waiting"
          : (error as { kind?: string }).kind === "CANCELLED"
            ? "cancelled"
            : "failed";
      if (state.status === "failed")
        state.error = error instanceof Error ? error.message : String(error);
    }
    const latest = await this.store.get<RunState>(id);
    if (latest?.status === "cancelled") state.status = "cancelled";
    if (latest) state.signals = latest.signals;
    await save();
    await this.publish(state);
  }
  async tick() {
    for (const id of await this.store.ids()) await this.run(id);
  }
  async cancel(id: string) {
    const state = await this.store.update<RunState>(id, (current) => {
      invariant(current, "NOT_FOUND", "Run is not on this device");
      return { ...current, status: "cancelled" };
    });
    await this.publish(state);
  }
  async signal(id: string, name: string, data: Value) {
    await this.store.update<RunState>(id, (state) => {
      invariant(
        state &&
          ["running", "waiting"].includes(state.status) &&
          allNodes(state.execution.graph).some(
            (n) => n.type === "signal" && n.config.name === name,
          ),
        "INVALID_SIGNAL",
        "This active run does not declare that signal",
      );
      state.signals[id + ":" + name] = data;
      return state;
    });
    await this.run(id);
    return { ok: true };
  }
  async close() {
    await Promise.allSettled(this.active.values());
  }
}
