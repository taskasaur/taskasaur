import { StorageCopiesButton } from "./storage-placement";
import { executionSlots } from "../core/execution";
import { ExecutionTarget } from "./execution-target";
import { selectedCollectionTable, belongsToTable } from "./collection-tables";
import { resourceManagers } from "./managed-resources";
import { collectionColumns } from "@taskasaur/platform/core/collection-tables";
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
import { RecordForm, displayValue } from "../ui/fields";
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
  /** Host supplies the owning plugin when editing managed shared resources. */
  managedAccess?: string;
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
  managedAccess,
  defaultView,
  renderCell,
  renderCard,
  columnOptions,
}: RecordTableProps) {
  const baseSchema = getSchema(collection);
  const activeTable = useLiveQuery(
    () =>
      baseSchema.tables && !schemaOverride
        ? selectedCollectionTable(runtime, collection)
        : Promise.resolve(undefined),
    [runtime, collection, Boolean(schemaOverride)],
  );
  const schema =
    schemaOverride ??
    (activeTable
      ? {
          ...baseSchema,
          fields: collectionColumns(baseSchema, activeTable.data.columns),
        }
      : baseSchema);
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
  const displaySchema = {
    ...schema,
    fields: schema.fields.filter((field) => field.visibility !== "hidden"),
  };
  const source = useMemo(
    () => storeOverride ?? runtime.collection(collection),
    [runtime, collection, storeOverride],
  );
  const store = useMemo(
    () =>
      !activeTable || schemaOverride
        ? source
        : {
            list: async () =>
              (await source.list())
                .filter((row) => belongsToTable(row, activeTable))
                .map((row) => ({
                  ...row,
                  data: {
                    ...row.data,
                    ...((row.data.custom_fields as Record<string, Value>) ??
                      {}),
                  },
                })),
            put: async (data: Record<string, Value>, id?: string) => {
              const old = id ? await runtime.db.records.get(id) : undefined;
              const values = { ...old?.data },
                custom = {
                  ...((old?.data.custom_fields as Record<string, Value>) ?? {}),
                };
              for (const [key, value] of Object.entries(data)) {
                if (
                  baseSchema.fields.some((f) => f.id === key) &&
                  !schema.fields.some(
                    (f) => f.id === key && f.storage === "custom",
                  )
                )
                  values[key] = value;
                else custom[key] = value;
              }
              const row = await source.put(
                { ...values, table_id: activeTable.id, custom_fields: custom },
                id,
              );
              return {
                ...row,
                data: {
                  ...row.data,
                  ...((row.data.custom_fields as Record<string, Value>) ?? {}),
                },
              };
            },
            delete: source.delete,
          },
    [runtime, source, activeTable, schemaOverride, baseSchema, schema.fields],
  );
  const rows = useLiveQuery(() => store.list(), [store]) ?? [];
  const managedRecords =
    useLiveQuery(() => runtime.db.records.toArray(), [runtime]) ?? [];
  const canonicalRows = useMemo(
    () => new Map(managedRecords.map((row) => [row.id, row])),
    [managedRecords],
  );
  const actionRow = (row: ResourceRecord) =>
    activeTable && !schemaOverride ? (canonicalRows.get(row.id) ?? row) : row;
  const managers = resourceManagers(managedRecords);
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
    (!row ||
      !["tables", "variables", "credentials", "files"].includes(collection) ||
      !managers.has(row.id) ||
      managers.get(row.id) === managedAccess) &&
    (!access
      ? !row || row.ownerId === runtime.principal.userId
      : access.workspaceWrite &&
        Date.now() - access.checkedAt < 86400000 &&
        (!row ||
          (row.revision === 0 && row.ownerId === runtime.principal.userId) ||
          access.writableIds.includes(row.id)));
  const key =
    "view." +
    (viewKey ?? (activeTable ? collection + "." + activeTable.id : collection));
  const preferenceKey = `taskasaur.view.${runtime.profile.id}.${key}`;
  const [state, setState] = useState(() => normalizeView(defaultView, schema));
  const schemaFields = JSON.stringify(schema.fields);
  const current = useRef(state),
    writeQueue = useRef(Promise.resolve()),
    edits = useRef(0);
  const [editor, setEditor] = useState<ResourceRecord | "new" | null>(null),
    [inspecting, setInspecting] = useState<ResourceRecord | null>(null),
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
      .then(async (saved) => {
        // View preferences are device-only. A synchronous mirror survives a
        // reload that interrupts IndexedDB's pending write transaction.
        try {
          const local = localStorage.getItem(preferenceKey);
          if (local) saved = JSON.parse(local);
        } catch {
          /* Use Dexie when localStorage is unavailable. */
        }
        if (!saved && activeTable?.data.is_default)
          saved = await runtime.db.getMetadata<Partial<CollectionViewState>>(
            "view." + collection,
          );
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
    // User-defined columns can change without a plugin schema version change.
  }, [
    runtime,
    key,
    schema.id,
    schema.version,
    schemaFields,
    activeTable?.revision,
  ]);
  const change = (patch: Partial<CollectionViewState>) => {
    edits.current++;
    const next = normalizeView({ ...current.current, ...patch }, schema);
    try {
      localStorage.setItem(preferenceKey, JSON.stringify(next));
    } catch {
      /* Dexie remains the fallback. */
    }
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
    else setInspecting(row);
  };
  useEffect(() => {
    const reveal = () => {
      const id = new URLSearchParams(location.hash.split("?")[1]).get("record");
      const row = rows.find((r) => r.id === id);
      if (id && row) {
        history.replaceState(null, "", location.hash.split("?")[0]);
        open(row);
      }
    };
    reveal();
    window.addEventListener("hashchange", reveal);
    return () => window.removeEventListener("hashchange", reveal);
  }, [rows, onOpen]);
  const update = async (row: ResourceRecord, patch: Record<string, Value>) => {
    try {
      if (!writable(row)) throw Error("This entry is read-only");
      const actionStore = activeTable && !schemaOverride ? source : store;
      const latest = (await actionStore.list()).find((r) => r.id === row.id);
      if (!latest) throw Error("This entry is no longer available");
      await actionStore.put({ ...latest.data, ...patch }, row.id);
      void runtime.synchronize().catch((e) => setError(e.message));
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const actions = (row: ResourceRecord) => (
    <>
      {["tables", "variables", "credentials", "files"].includes(collection) &&
        managers.has(row.id) &&
        !managedAccess && (
          <span className="text-xs text-muted-foreground">
            Managed by {managers.get(row.id)}
          </span>
        )}
      <StorageCopiesButton runtime={runtime} record={row} />
      {renderActions?.(actionRow(row), {
        writable: writable(row),
        update: (patch) => update(row, patch),
      })}
      {slots.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Execution settings"
          onClick={() => setExecution(actionRow(row))}
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
          fields={displaySchema.fields}
          query={state.query}
          onChange={(query) => change({ query })}
          columns={state.columns}
          columnOrder={state.columnOrder}
          onColumns={(columns, columnOrder) => change({ columns, columnOrder })}
          groups={state.groups}
          onGroups={(groups) => change({ groups })}
          mode={state.mode}
          onMode={(mode) => change({ mode })}
        />
        <div className="flex max-w-full flex-wrap gap-2">
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
        schema={displaySchema}
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
              initial={
                editor === "new"
                  ? undefined
                  : Object.fromEntries(
                      Object.entries(editor.data).filter(([id]) =>
                        editSchema.fields.some((f) => f.id === id),
                      ),
                    )
              }
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
        open={Boolean(inspecting)}
        onOpenChange={(open) => {
          if (!open) setInspecting(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{schema.name} entry</DialogTitle>
          </DialogHeader>
          {inspecting?.managedBy && (
            <p className="text-sm text-muted-foreground">
              Managed by {inspecting.managedBy}
            </p>
          )}
          <dl className="space-y-3">
            {schema.fields
              .filter((f) => !f.sensitive)
              .map((f) => (
                <div key={f.id}>
                  <dt className="text-sm font-medium">{f.label}</dt>
                  <dd className="break-words whitespace-pre-wrap text-sm text-muted-foreground">
                    {displayValue(inspecting?.data[f.id], f)}
                  </dd>
                </div>
              ))}
          </dl>
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
