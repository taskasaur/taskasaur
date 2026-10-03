import { useEffect, useState, useCallback, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { ExecutionState } from "@taskasaur/platform/plugin-sdk/execution";
import type { InventoryEntry } from "@taskasaur/platform/plugin-sdk/inventory";
import { currentPolicy } from "../core/identity";
import {
  executionRequirements,
  inspectExecution,
  slotFor,
} from "../core/execution";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
import { Switch } from "../ui/primitives/switch";
import { ChoiceSelect } from "../ui/choice-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "../ui/primitives/dialog";

export interface ExecutionTargetProps {
  runtime: AppRuntime;
  resourceId: string;
  slotId?: string;
  readOnly?: boolean;
}
/** Shared per-item execution controls; only declared execution slots get a picker. */
export function ExecutionTarget({
  runtime,
  resourceId,
  slotId,
  readOnly = false,
}: ExecutionTargetProps) {
  const record = useLiveQuery(
    () => runtime.db.records.get(resourceId),
    [runtime, resourceId],
  );
  const slot = record && slotFor(record, slotId);
  const [state, setState] = useState<ExecutionState>(),
    [selected, setSelected] = useState(""),
    [enabled, setEnabled] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [plan, setPlan] = useState<InventoryEntry[] | null>(null);
  const refreshSequence = useRef(0),
    refreshing = useRef(0);
  const refresh = useCallback(async () => {
    const latest = runtime.node.records.get(resourceId);
    const definition = latest && slotFor(latest, slotId);
    if (!latest || !definition) return;
    const sequence = ++refreshSequence.current;
    refreshing.current++;
    try {
      const next = await inspectExecution(runtime.node, latest, definition);
      if (sequence === refreshSequence.current) setState(next);
      return next;
    } finally {
      refreshing.current--;
    }
  }, [runtime, resourceId, slotId]);
  useEffect(() => {
    let live = true;
    const poll = () =>
      void refresh().catch((e) => {
        if (live) setError(e.message);
      });
    poll();
    const timer = setInterval(() => {
      if (!refreshing.current) poll();
    }, 10000);
    return () => {
      live = false;
      refreshSequence.current++;
      clearInterval(timer);
    };
  }, [refresh]);
  useEffect(() => {
    if (state && !dirty) {
      setSelected(state.binding?.deviceId ?? "");
      setEnabled(state.enabled);
    }
  }, [state, dirty]);
  const target = state?.candidates.find((p) => p.id === selected);
  const writable = !readOnly && runtime.node.records.canWrite();
  const canInstall =
    currentPolicy(runtime.node.replica.access).members[
      runtime.device.identity.id
    ]?.userId ===
    currentPolicy(runtime.node.replica.access).members[
      currentPolicy(runtime.node.replica.access).owner.id
    ]?.userId;
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  if (!record || !slot) return null;
  const requirements = executionRequirements(slot, record);
  return (
    <section
      className="space-y-3 rounded-xl border p-4"
      aria-label={slot.label}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{slot.label}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              await runtime.synchronize();
              await refresh();
            })
          }
        >
          Refresh status
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Choose where this item runs. Its content stays available on your other
        devices.
      </p>
      <label className="grid gap-2 text-sm">
        Execution computer
        <ChoiceSelect
          aria-label="Execution computer"
          value={selected}
          disabled={busy || !writable}
          onValueChange={(value) => {
            setSelected(value);
            setDirty(true);
            setPlan(null);
          }}
          placeholder="Choose a computer"
          options={(state?.candidates ?? []).map((p) => ({
            value: p.id,
            label: `${p.name} · ${p.online ? (p.ready ? "Ready" : "Needs setup") : "Offline"}`,
          }))}
        />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <Switch
          aria-label="Enable item execution"
          checked={enabled}
          disabled={busy || !writable || !selected}
          onCheckedChange={(value) => {
            setEnabled(value);
            setDirty(true);
          }}
        />
        Enable execution for this item
      </label>
      {target && (
        <div className="space-y-2 text-sm" role="status">
          <p>
            {!target.online
              ? "Offline — availability and installed plugins cannot be verified until connected."
              : !target.statusKnown
                ? "Could not verify this computer’s plugin status."
                : target.ready
                  ? "This computer has the required plugins and capabilities."
                  : "Setup is needed on this computer before execution can start."}
          </p>
          {target.error && <p>{target.error}</p>}
          <ul className="space-y-1">
            {requirements.plugins.map((p) => {
              const installed = target.plugins.find((s) => s.id === p.id),
                missing = target.missingPlugins.find((s) => s.id === p.id);
              return (
                <li key={p.id}>
                  {p.id}
                  {p.version ? ` @ ${p.version}` : ""}:{" "}
                  {!target.statusKnown
                    ? "Unknown"
                    : missing
                      ? `${missing.reason}${installed?.version ? ` (${installed.version})` : ""}`
                      : `Enabled (${installed?.version})`}
                </li>
              );
            })}
          </ul>
          {target.statusKnown && target.missingCapabilities.length > 0 && (
            <p>
              Enable on this computer: {target.missingCapabilities.join(", ")}.
              Device permissions are controlled in Devices on that computer.
            </p>
          )}
          {target.statusKnown && target.missingPlugins.length > 0 && (
            <>
              <Button
                variant="outline"
                disabled={
                  busy || !writable || !canInstall || !target.canInstall
                }
                onClick={() =>
                  void act(async () =>
                    setPlan(
                      await runtime.executionInstallPlan(
                        record,
                        slot,
                        selected,
                      ),
                    ),
                  )
                }
              >
                Review plugin installation
              </Button>
              {!target.canInstall && (
                <p>
                  Allow remote plugin installation in Devices on that computer
                  first.
                </p>
              )}
              {!canInstall && (
                <p>
                  The workspace owner can install the required plugins remotely.
                </p>
              )}
            </>
          )}
        </div>
      )}
      {!state?.configured && (
        <p className="text-sm">
          No execution computer assigned. Choose one and save before running
          this item.
        </p>
      )}
      {state?.configured && !state.enabled && (
        <p className="text-sm">Execution is off for this item.</p>
      )}
      <Button
        disabled={
          busy ||
          !writable ||
          !selected ||
          (!dirty && Boolean(state?.configured))
        }
        onClick={() =>
          void act(async () => {
            await runtime.configureItemExecution(
              record,
              slot,
              selected,
              enabled,
            );
            setDirty(false);
            await refresh();
            setNotice(
              "Execution settings saved. Offline devices receive changes when they reconnect.",
            );
          })
        }
      >
        Save execution settings
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <Dialog
        open={plan !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPlan(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Install plugins on {target?.name}</DialogTitle>
            <DialogDescription>
              Review the packages and permissions. Installation enables these
              plugins on the selected computer.
            </DialogDescription>
          </DialogHeader>
          {plan?.map((entry) => (
            <div key={entry.id} className="space-y-1 border-b pb-3 text-sm">
              <p className="font-medium">
                {entry.name} · {entry.version}
              </p>
              <p className="break-words">
                Permissions: {entry.grants.join(", ") || "None"}
              </p>
              <details>
                <summary>Verified package</summary>
                <p className="break-all">SHA-256: {entry.sha256}</p>
              </details>
            </div>
          ))}
          {plan?.length === 0 && (
            <p>All required packages are already installed and enabled.</p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            disabled={busy || !plan?.length}
            onClick={() =>
              void act(async () => {
                await runtime.installExecutionPlugins(selected, plan!);
                setPlan(null);
                await refresh();
                setNotice(
                  "Plugins installed and enabled. Review any remaining device permissions above.",
                );
              })
            }
          >
            {busy ? "Installing…" : "Install and enable reviewed plugins"}
          </Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
