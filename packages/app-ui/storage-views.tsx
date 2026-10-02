"use client";
import { serverFetch } from "./network";
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
      else if (runtime.profile.connected) {
        const url = new URL("/api/files", runtime.profile.serverUrl);
        url.searchParams.set("workspaceId", runtime.profile.workspaceId);
        url.searchParams.set("id", record.id);
        const response = await serverFetch(url, { credentials: "include" });
        if (!response.ok) throw new Error("File download failed");
        download(String(record.data.name), await response.blob());
      } else throw new Error("This file is not available on this device");
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
            <input
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
    <UserTable
      runtime={runtime}
      table={selected}
      onBack={() => setSelected(null)}
    />
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
          <Button variant="outline" onClick={() => setColumn(true)}>
            Add column
          </Button>
          <Button onClick={() => setEditing("new")}>
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
                  choices: [
                    "text",
                    "integer",
                    "bigint",
                    "numeric",
                    "boolean",
                    "date",
                    "timestamp with time zone",
                    "uuid",
                    "jsonb",
                  ],
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
export function DevicesView({ runtime }: { runtime: AppRuntime }) {
  const [error, setError] = useState(""),
    [enrollment, setEnrollment] = useState<{
      code: string;
      expiresAt: string;
    } | null>(null),
    [pairing, setPairing] = useState(false),
    [capabilities, setCapabilities] = useState<{
      terminalHost: boolean;
      automationExecute: boolean;
      secureCredentials: boolean;
    } | null>(null);
  useEffect(() => {
    void window.taskasaurNative
      ?.capabilities()
      .then(setCapabilities)
      .catch(() => undefined);
  }, []);
  return (
    <div className="space-y-4">
      <p className="page-description">
        Linked devices share one identity and capability contract. Online
        devices can offer automation execution or terminal access when enabled.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <RecordTable
        runtime={runtime}
        collection="devices"
        hideCreate
        readOnly
        renderActions={(row) => {
          const online =
            !row.data.revoked &&
            Date.now() - Date.parse(String(row.data.last_seen)) < 45000;
          return (
            <span className="flex gap-1 items-center text-xs">
              {online ? <Wifi size={14} /> : <WifiOff size={14} />}{" "}
              {online ? "Online" : "Offline"}
              {!row.data.revoked && row.data.platform !== "server" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await runtime.api("devices/revoke", { id: row.id });
                      await runtime.synchronize();
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Revoke
                </Button>
              )}
            </span>
          );
        }}
        toolbar={
          <>
            <Button
              variant="outline"
              disabled={!runtime.profile.connected}
              onClick={async () => {
                try {
                  const enrollment = await runtime.api<{
                    code: string;
                    expiresAt: string;
                  }>("devices/enroll", {});
                  setEnrollment(enrollment);
                  setError("");
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
            >
              Link computer
            </Button>
            {capabilities?.secureCredentials && (
              <Button
                disabled={!runtime.profile.connected}
                onClick={() => setPairing(true)}
              >
                Link this computer
              </Button>
            )}
          </>
        }
      />
      {enrollment && (
        <div className="rounded-lg border p-4 space-y-2">
          <p>
            Pairing code: <code>{enrollment.code}</code>
          </p>
          <p className="text-sm text-muted-foreground">
            Expires {new Date(enrollment.expiresAt).toLocaleTimeString()}. Open
            Taskasaur on the other computer and use its device pairing screen,
            or run the device CLI with this code.
          </p>
          <Button variant="ghost" onClick={() => setEnrollment(null)}>
            Dismiss
          </Button>
        </div>
      )}
      <Dialog open={pairing} onOpenChange={setPairing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Link this computer</DialogTitle>
          </DialogHeader>
          <RecordForm
            schema={{
              id: "pair",
              pluginId: "devices",
              name: "Pair",
              version: 1,
              fields: [
                field("code", "Pairing code (leave empty for this workspace)"),
                field(
                  "terminal",
                  "Allow incoming terminal sessions",
                  "boolean",
                  { default: false },
                ),
                field("automation", "Allow TypeScript automations", "boolean", {
                  default: false,
                }),
              ],
            }}
            onCancel={() => setPairing(false)}
            onSave={async (data) => {
              if (data.terminal && !capabilities?.terminalHost)
                throw new Error("This host cannot run terminals");
              if (data.automation && !capabilities?.automationExecute)
                throw new Error("This host cannot execute automations");
              const code =
                data.code ||
                (await runtime.api<{ code: string }>("devices/enroll", {}))
                  .code;
              await window.taskasaurNative!.pair({
                serverUrl: runtime.profile.serverUrl,
                code: String(code),
                terminal: data.terminal === true,
                automation: data.automation === true,
              });
              setPairing(false);
              await runtime.synchronize();
            }}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
