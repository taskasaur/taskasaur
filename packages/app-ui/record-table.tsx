"use client";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Trash2, Pencil, ArrowUp, ArrowDown } from "lucide-react";
import { getSchema } from "../core/catalog";
import {
  queryRecords,
  type Query,
  type Value,
  type RecordSchema,
} from "../field-types";
import type { ResourceRecord } from "../plugin-sdk";
import type { AppRuntime } from "./runtime";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import { Button } from "../ui/primitives/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
} from "../ui/primitives/dialog";
import { RecordForm, displayValue } from "../ui/fields";
import { QueryControls } from "../ui/query-controls";

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
}: {
  runtime: AppRuntime;
  collection: string;
  toolbar?: ReactNode;
  renderActions?: (row: ResourceRecord) => ReactNode;
  onOpen?: (row: ResourceRecord) => void;
  hideCreate?: boolean;
  schemaOverride?: RecordSchema;
  storeOverride?: {
    list: () => Promise<ResourceRecord[]>;
    put: (data: unknown, id?: string) => Promise<ResourceRecord>;
    delete: (id: string) => Promise<void>;
  };
  viewKey?: string;
  readOnly?: boolean;
}) {
  const schema = schemaOverride ?? getSchema(collection),
    store = useMemo(
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
  const saved = useLiveQuery(
    () =>
      runtime.db.getMetadata<{ query: Query; columns: string[] }>(
        `view.${viewKey ?? collection}`,
      ),
    [runtime, collection, viewKey],
  );
  const [query, setQuery] = useState<Query>({}),
    [columns, setColumns] = useState(
      schema.fields.slice(0, 5).map((f) => f.id),
    );
  const [editor, setEditor] = useState<ResourceRecord | "new" | null>(null),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState<ResourceRecord | null>(null);
  useEffect(() => {
    setQuery(saved?.query ?? {});
    setColumns(saved?.columns ?? schema.fields.slice(0, 5).map((f) => f.id));
  }, [collection, saved, schema]);
  const changeQuery = (next: Query) => {
    setQuery(next);
    void runtime.db.setMetadata(`view.${viewKey ?? collection}`, {
      query: next,
      columns,
    });
  };
  const changeColumns = (next: string[]) => {
    setColumns(next);
    void runtime.db.setMetadata(`view.${viewKey ?? collection}`, {
      query,
      columns: next,
    });
  };
  let filtered: ResourceRecord[] = [];
  let queryError = "";
  try {
    filtered = queryRecords(rows, schema, query);
  } catch (e) {
    queryError = e instanceof Error ? e.message : String(e);
  }
  const fields = columns
    .map((id) => schema.fields.find((f) => f.id === id))
    .filter((f) => f !== undefined);
  const groups = new Map<string, ResourceRecord[]>();
  for (const row of filtered) {
    const key = query.groupBy ? displayValue(row.data[query.groupBy]) : "";
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <QueryControls
          fields={schema.fields}
          query={query}
          onChange={changeQuery}
          columns={columns}
          onColumns={changeColumns}
        />
        <div className="flex gap-2">
          {toolbar}
          {!hideCreate && writable() && (
            <Button onClick={() => setEditor("new")}>
              <Plus size={16} />
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
      {[...groups.entries()].map(([group, entries]) => (
        <div key={group}>
          {query.groupBy && (
            <h3 className="text-sm font-semibold py-3">
              {group}{" "}
              <span className="text-muted-foreground">{entries.length}</span>
            </h3>
          )}
          <div className="rounded-xl border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  {fields.map((f) => (
                    <TableHead key={f.id}>
                      <button
                        className="flex items-center gap-1"
                        onClick={() =>
                          changeQuery({
                            ...query,
                            sorts: [
                              {
                                field: f.id,
                                direction:
                                  query.sorts?.[0]?.field === f.id &&
                                  query.sorts[0].direction === "asc"
                                    ? "desc"
                                    : "asc",
                                enabled: true,
                              },
                              ...(query.sorts ?? []).filter(
                                (s) => s.field !== f.id,
                              ),
                            ],
                          })
                        }
                      >
                        {f.label}
                        {query.sorts?.[0]?.field === f.id &&
                          (query.sorts[0].direction === "asc" ? (
                            <ArrowUp size={12} />
                          ) : (
                            <ArrowDown size={12} />
                          ))}
                      </button>
                    </TableHead>
                  ))}
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((row) => (
                  <TableRow
                    key={row.id}
                    onDoubleClick={() =>
                      onOpen ? onOpen(row) : writable(row) && setEditor(row)
                    }
                  >
                    {fields.map((f) => (
                      <TableCell key={f.id} className="max-w-80 truncate">
                        {f.id === "title" ||
                        f.id === "name" ||
                        f.id === "summary" ||
                        f.id === "subject" ? (
                          <button
                            className="text-left hover:underline font-medium"
                            onClick={() =>
                              onOpen
                                ? onOpen(row)
                                : writable(row) && setEditor(row)
                            }
                          >
                            {displayValue(row.data[f.id], f) === "—"
                              ? "Untitled"
                              : displayValue(row.data[f.id], f)}
                          </button>
                        ) : (
                          displayValue(row.data[f.id], f)
                        )}
                      </TableCell>
                    ))}
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        {renderActions?.(row)}
                        {writable(row) && (
                          <>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Edit entry"
                              onClick={() => setEditor(row)}
                            >
                              <Pencil size={14} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label="Delete entry"
                              onClick={() => setConfirmDelete(row)}
                            >
                              <Trash2 size={14} />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      ))}
      {!filtered.length && (
        <div className="empty-state">
          <h3>
            {rows.length
              ? "No matching entries"
              : `No ${schema.name.toLowerCase()} yet`}
          </h3>
          <p>
            {rows.length
              ? "Adjust the filters to see more entries."
              : "Create an entry to get started. Your changes are saved on this device."}
          </p>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        {filtered.length} {filtered.length === 1 ? "entry" : "entries"}
        {runtime.profile.connected
          ? " · Changes synchronize with your workspace"
          : " · Saved on this device"}
      </div>
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
              schema={schema}
              initial={editor === "new" ? undefined : editor.data}
              onCancel={() => setEditor(null)}
              onSave={async (data: Record<string, Value>) => {
                await store.put(data, editor === "new" ? undefined : editor.id);
                setEditor(null);
                void runtime.synchronize().catch((e) => setError(e.message));
              }}
            />
          )}
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
