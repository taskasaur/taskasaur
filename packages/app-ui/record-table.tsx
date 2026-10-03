import { executionSlots } from "../core/execution";
import { ExecutionTarget } from "./execution-target";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Trash2, Pencil, Monitor } from "lucide-react";
import { getSchema } from "@taskasaur/platform/core/catalog";
import {
  queryRecords,
  type Value,
  type RecordSchema,
} from "@taskasaur/platform/field-types";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type { AppRuntime } from "./runtime";
import { Button } from "../ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
} from "../ui/primitives/dialog";
import { RecordForm } from "../ui/fields";
import { QueryControls } from "../ui/query-controls";
import {
  CollectionView,
  type CellContext,
  type ColumnOptions,
} from "../ui/collection-view";
import {
  normalizeView,
  type CollectionViewState,
} from "../ui/collection-view-model";

export interface RecordTableProps {
  runtime: AppRuntime;
  collection: string;
  toolbar?: ReactNode;
  renderActions?: (
    row: ResourceRecord,
    context: {
      writable: boolean;
      update: (patch: Record<string, Value>) => Promise<void>;
    },
  ) => ReactNode;
  onOpen?: (row: ResourceRecord) => void;
  hideCreate?: boolean;
  schemaOverride?: RecordSchema;
  storeOverride?: {
    list: () => Promise<ResourceRecord[]>;
    put: (data: any, id?: string) => Promise<ResourceRecord>;
    delete: (id: string) => Promise<unknown>;
  };
  viewKey?: string;
  readOnly?: boolean;
  defaultView?: Partial<CollectionViewState>;
  renderCell?: (context: CellContext) => ReactNode;
  renderCard?: (row: ResourceRecord, defaultContent: ReactNode) => ReactNode;
  columnOptions?: Record<string, ColumnOptions>;
}
/** Storage/permissions adapter. Every plugin gets the same collection presentation. */
export function RecordTable({
  runtime,
  collection,
  toolbar,
  renderActions,
  onOpen,
  hideCreate = false,
  schemaOverride,
  storeOverride,
  viewKey,
  readOnly = false,
  defaultView,
  renderCell,
  renderCard,
  columnOptions,
}: RecordTableProps) {
  const schema = schemaOverride ?? getSchema(collection);
  const slots = executionSlots().filter(
    (slot) => slot.collection === collection,
  );
  const [execution, setExecution] = useState<ResourceRecord | null>(null);
  const editSchema = {
    ...schema,
    fields: schema.fields.filter(
      (field) =>
        !slots.some(
          (slot) =>
            slot.targetField === field.id || slot.enabledField === field.id,
        ),
    ),
  };
  const store = useMemo(
    () => storeOverride ?? runtime.collection(collection),
    [runtime, collection, storeOverride],
  );
  const rows = useLiveQuery(() => store.list(), [store]) ?? [];
  const access = useLiveQuery(
    () =>
      runtime.db.getMetadata<{
        writableIds: string[];
        workspaceWrite: boolean;
        checkedAt: number;
      }>("access.snapshot"),
    [runtime],
  );
  const writable = (row?: ResourceRecord) =>
    !readOnly &&
    (!access
      ? !row || row.ownerId === runtime.principal.userId
      : access.workspaceWrite &&
        Date.now() - access.checkedAt < 86400000 &&
        (!row ||
          (row.revision === 0 && row.ownerId === runtime.principal.userId) ||
          access.writableIds.includes(row.id)));
  const key = "view." + (viewKey ?? collection);
  const [state, setState] = useState(() => normalizeView(defaultView, schema));
  const current = useRef(state),
    writeQueue = useRef(Promise.resolve()),
    edits = useRef(0);
  const [editor, setEditor] = useState<ResourceRecord | "new" | null>(null),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState<ResourceRecord | null>(null);
  useEffect(() => {
    let canceled = false;
    const revision = ++edits.current;
    const initial = normalizeView(defaultView, schema);
    current.current = initial;
    setState(initial);
    void runtime.db
      .getMetadata<Partial<CollectionViewState>>(key)
      .then((saved) => {
        if (canceled || edits.current !== revision) return;
        const next = normalizeView(saved ?? defaultView, schema);
        current.current = next;
        setState(next);
      })
      .catch((e) => {
        if (!canceled) setError(String(e));
      });
    return () => {
      canceled = true;
    };
    // Schema changes are keyed by version; object identities from plugin renders need not be stable.
  }, [runtime, key, schema.id, schema.version]);
  const change = (patch: Partial<CollectionViewState>) => {
    edits.current++;
    const next = normalizeView({ ...current.current, ...patch }, schema);
    current.current = next;
    setState(next);
    writeQueue.current = writeQueue.current
      .then(() => runtime.db.setMetadata(key, next))
      .catch((e) => setError(String(e)));
  };
  let filtered: ResourceRecord[] = [],
    queryError = "";
  try {
    filtered = queryRecords(rows, schema, state.query);
  } catch (e) {
    queryError = e instanceof Error ? e.message : String(e);
  }
  const open = (row: ResourceRecord) => {
    if (onOpen) onOpen(row);
    else if (writable(row)) setEditor(row);
  };
  const update = async (row: ResourceRecord, patch: Record<string, Value>) => {
    try {
      if (!writable(row)) throw Error("This entry is read-only");
      const latest = (await store.list()).find((r) => r.id === row.id);
      if (!latest) throw Error("This entry is no longer available");
      await store.put({ ...latest.data, ...patch }, row.id);
      void runtime.synchronize().catch((e) => setError(e.message));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const actions = (row: ResourceRecord) => (
    <>
      {renderActions?.(row, {
        writable: writable(row),
        update: (patch) => update(row, patch),
      })}
      {slots.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Execution settings"
          onClick={() => setExecution(row)}
        >
          <Monitor />
        </Button>
      )}
      {writable(row) && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit entry"
            onClick={() => setEditor(row)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete entry"
            onClick={() => setConfirmDelete(row)}
          >
            <Trash2 />
          </Button>
        </>
      )}
    </>
  );
  return (
    <div className="min-w-0 space-y-4" data-record-collection={collection}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <QueryControls
          fields={schema.fields}
          query={state.query}
          onChange={(query) => change({ query })}
          columns={state.columns}
          onColumns={(columns) => change({ columns })}
          groups={state.groups}
          onGroups={(groups) => change({ groups })}
          mode={state.mode}
          onMode={(mode) => change({ mode })}
        />
        <div className="flex gap-2">
          {toolbar}
          {!hideCreate && writable() && (
            <Button onClick={() => setEditor("new")}>
              <Plus />
              New entry
            </Button>
          )}
        </div>
      </div>
      {(error || queryError) && (
        <div role="alert" className="error-banner">
          {error || queryError}
        </div>
      )}
      <CollectionView
        schema={schema}
        rows={filtered}
        state={state}
        onChange={change}
        onOpen={open}
        renderActions={actions}
        renderCell={renderCell}
        renderCard={renderCard}
        columnOptions={columnOptions}
        writable={writable}
        onUpdate={update}
      />
      {!rows.length && (
        <div className="empty-state">
          <h3>No {schema.name.toLowerCase()} yet</h3>
          <p>
            Create an entry to get started. Your changes are saved on this
            device.
          </p>
        </div>
      )}
      <Dialog
        open={editor !== null}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>
              {editor === "new" ? "New" : "Edit"} {schema.name.toLowerCase()}{" "}
              entry
            </DialogTitle>
          </DialogHeader>
          {editor && (
            <RecordForm
              key={editor === "new" ? "new" : editor.id}
              schema={editSchema}
              initial={editor === "new" ? undefined : editor.data}
              onCancel={() => setEditor(null)}
              onSave={async (data: Record<string, Value>) => {
                const saved = await store.put(
                  editor === "new"
                    ? data
                    : { ...runtime.node.records.get(editor.id)?.data, ...data },
                  editor === "new" ? undefined : editor.id,
                );
                if (editor === "new" && slots.length) setExecution(saved);
                setEditor(null);
                void runtime.synchronize().catch((e) => setError(e.message));
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog
        open={Boolean(execution)}
        onOpenChange={(open) => {
          if (!open) setExecution(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>Execution settings</DialogTitle>
          </DialogHeader>
          {execution &&
            slots.map((slot) => (
              <ExecutionTarget
                key={slot.id}
                runtime={runtime}
                resourceId={execution.id}
                slotId={slot.id}
                readOnly={!writable(execution)}
              />
            ))}
        </DialogContent>
      </Dialog>
      <Dialog
        open={confirmDelete !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this entry?</DialogTitle>
          </DialogHeader>
          <p>
            The entry will be removed from active views. Its deletion is
            synchronized when connected.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                try {
                  await store.delete(confirmDelete!.id);
                  setConfirmDelete(null);
                  void runtime.synchronize().catch((e) => setError(e.message));
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
