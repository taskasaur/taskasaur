"use client";

import { SharedInput } from "../ui/html-controls";
import { useState, useMemo, useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  Upload,
  Download,
  KeyRound,
  Plus,
  ArrowLeft,
  File,
  Wifi,
  WifiOff,
} from "lucide-react";
import type { AppRuntime } from "./runtime";
import { RecordTable } from "./record-table";
import { download } from "./download";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogHeader,
} from "../ui/primitives/dialog";
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "../ui/primitives/table";
import {
  fieldDescriptor,
  field,
  validateRecord,
  type Field,
  type RecordSchema,
  type Value,
} from "@taskasaur/platform/field-types";
import { RecordForm, displayValue } from "../ui/fields";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { belongsToTable } from "./collection-tables";
import { pgTypes } from "@taskasaur/platform/field-types";

export function FilesView({ runtime }: { runtime: AppRuntime }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function upload(file: globalThis.File) {
    setBusy(true);
    try {
      const metadata = await runtime.collection("files").put({
        name: file.name,
        media_type: file.type || "application/octet-stream",
        size: String(file.size),
      });
      await runtime.db.saveFile(runtime.principal, metadata.id, file, null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function retrieve(record: ResourceRecord) {
    try {
      const version = record.data.version_id
        ? await runtime.db.fileVersions.get(String(record.data.version_id))
        : undefined;
      if (version) download(String(record.data.name), version.blob);
      else {
        await runtime.synchronize();
        download(
          String(record.data.name),
          (await runtime.fileBytes(record.id)).blob,
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }
  return (
    <div className="space-y-4">
      <p className="page-description">
        Shared files and immutable local versions. Files you add are available
        on this device offline.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="files"
        hideCreate
        toolbar={
          <label className="upload-button">
            <Upload size={14} />
            {busy ? "Saving…" : "Upload files"}
            <SharedInput
              hidden
              type="file"
              multiple
              disabled={busy}
              onChange={async (e) => {
                for (const file of Array.from(e.target.files ?? []))
                  await upload(file);
                e.target.value = "";
              }}
            />
          </label>
        }
        onOpen={(record) => void retrieve(record)}
        renderActions={(record) => (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Download file"
            onClick={() => void retrieve(record)}
          >
            <Download size={14} />
          </Button>
        )}
      />
    </div>
  );
}
export { default as CredentialsView } from "./credentials-view";
export function TablesView({ runtime }: { runtime: AppRuntime }) {
  const [selected, setSelected] = useState<ResourceRecord | null>(null),
    [newTable, setNewTable] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  return selected ? (
    selected.data.collection_id ? (
      <ManagedCollectionTable
        runtime={runtime}
        table={selected}
        onBack={() => setSelected(null)}
      />
    ) : (
      <UserTable
        runtime={runtime}
        table={selected}
        onBack={() => setSelected(null)}
      />
    )
  ) : (
    <>
      <RecordTable
        runtime={runtime}
        collection="tables"
        onOpen={setSelected}
        hideCreate
        toolbar={
          <Button onClick={() => setNewTable(true)}>
            <Plus size={14} />
            New table
          </Button>
        }
      />
      <Dialog open={newTable} onOpenChange={setNewTable}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create table</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const table = await runtime.collection("tables").put({
                  name,
                  columns: [
                    field("name", "Name", "text", {
                      required: true,
                      nullable: false,
                    }),
                  ],
                });
                setSelected(table);
                setNewTable(false);
                setName("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <label className="field-row">
              Name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <Button className="mt-4">Create table</Button>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
function UserTable({
  runtime,
  table: initial,
  onBack,
}: {
  runtime: AppRuntime;
  table: ResourceRecord;
  onBack: () => void;
}) {
  const table =
    useLiveQuery(
      () => runtime.db.records.get(initial.id),
      [runtime, initial.id],
    ) ?? initial;
  const allRows =
    useLiveQuery(() => runtime.collection("table_rows").list(), [runtime]) ??
    [];
  const rows = allRows.filter((r) => r.data.table_id === table.id),
    [editing, setEditing] = useState<ResourceRecord | "new" | null>(null),
    [column, setColumn] = useState(false),
    [error, setError] = useState("");
  const columns = useMemo(() => {
    try {
      return fieldDescriptor.array().parse(table.data.columns);
    } catch {
      return [];
    }
  }, [table.data.columns]);
  const schema = useMemo<RecordSchema>(
    () => ({
      id: table.id,
      pluginId: "tables",
      name: String(table.data.name),
      version: 1,
      fields: columns,
    }),
    [table.id, table.data.name, columns],
  );
  const store = useMemo(
    () => ({
      list: async () =>
        (await runtime.collection("table_rows").list())
          .filter((r) => r.data.table_id === table.id)
          .map((r) => ({ ...r, data: r.data.values as Record<string, Value> })),
      put: async (data: unknown, id?: string) => {
        const row = await runtime
          .collection("table_rows")
          .put(
            { table_id: table.id, values: validateRecord(schema, data) },
            id,
          );
        return { ...row, data: row.data.values as Record<string, Value> };
      },
      delete: (id: string) => runtime.collection("table_rows").delete(id),
    }),
    [runtime, table.id, schema],
  );
  return (
    <div className="space-y-4">
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft size={14} />
          Tables
        </Button>
        <h2 className="font-semibold">{String(table.data.name)}</h2>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={Boolean(table.managedBy)}
            onClick={() => setColumn(true)}
          >
            Add column
          </Button>
          <Button
            disabled={Boolean(table.managedBy)}
            onClick={() => setEditing("new")}
          >
            <Plus size={14} />
            New row
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="table_rows"
        viewKey={"table." + table.id}
        schemaOverride={schema}
        storeOverride={store}
        hideCreate
        readOnly={Boolean(table.managedBy)}
      />
      <Dialog
        open={Boolean(editing)}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing === "new" ? "New" : "Edit"} row</DialogTitle>
          </DialogHeader>
          {editing && (
            <RecordForm
              schema={schema}
              initial={
                editing === "new"
                  ? undefined
                  : (editing.data.values as Record<string, Value>)
              }
              onCancel={() => setEditing(null)}
              onSave={async (values) => {
                await runtime.collection("table_rows").put(
                  {
                    table_id: table.id,
                    values: validateRecord(schema, values),
                  },
                  editing === "new" ? undefined : editing.id,
                );
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={column} onOpenChange={setColumn}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add column</DialogTitle>
          </DialogHeader>
          <RecordForm
            schema={{
              id: "column",
              pluginId: "tables",
              name: "Column",
              version: 1,
              fields: [
                field("id", "Stable column ID", "text", {
                  required: true,
                  nullable: false,
                }),
                field("label", "Label", "text", {
                  required: true,
                  nullable: false,
                }),
                field("pg_type", "PostgreSQL type", "text", {
                  required: true,
                  nullable: false,
                  choices: [...pgTypes],
                  default: "text",
                }),
              ],
            }}
            onCancel={() => setColumn(false)}
            onSave={async (values) => {
              const next = fieldDescriptor.parse({
                ...values,
                pgType: values.pg_type,
              });
              if (columns.some((c) => c.id === next.id))
                throw new Error("This column ID already exists");
              await runtime.collection("tables").put(
                {
                  ...table.data,
                  columns: [...columns, next] as unknown as Value,
                },
                table.id,
              );
              setColumn(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
export { PeerDevicesView as DevicesView } from "./peer-devices";

function ManagedCollectionTable({
  runtime,
  table,
  onBack,
}: {
  runtime: AppRuntime;
  table: ResourceRecord;
  onBack: () => void;
}) {
  const collection = String(table.data.collection_id);
  const fields = fieldDescriptor.array().parse(table.data.columns);
  const base = schemaById.get(collection);
  const schema: RecordSchema = {
    id: collection,
    pluginId: table.managedBy ?? "tables",
    name: String(table.data.name),
    version: base?.version ?? 1,
    fields,
  };
  const store = useMemo(
    () => ({
      list: async () =>
        (
          await runtime.db.records
            .where("collection")
            .equals(collection)
            .filter((r) => !r.deletedAt)
            .toArray()
        )
          .filter((r) => belongsToTable(r, table))
          .map((r) => ({
            ...r,
            data: {
              ...r.data,
              ...((r.data.custom_fields as Record<string, Value>) ?? {}),
            },
          })),
      put: async (): Promise<ResourceRecord> => {
        throw Error("Edit this table in its owning plugin");
      },
      delete: async () => {
        throw Error("Edit this table in its owning plugin");
      },
    }),
    [runtime, collection, table],
  );
  return (
    <div className="space-y-4">
      <Button variant="ghost" onClick={onBack}>
        <ArrowLeft />
        Tables
      </Button>
      <p className="text-sm text-muted-foreground">
        Managed by {table.managedBy}. Open that plugin to edit its columns and
        entries.
      </p>
      <RecordTable
        runtime={runtime}
        collection={base ? collection : "table_rows"}
        schemaOverride={schema}
        storeOverride={store}
        readOnly
        viewKey={"storage." + table.id}
      />
    </div>
  );
}
