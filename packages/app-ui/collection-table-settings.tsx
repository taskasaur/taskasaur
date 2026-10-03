import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { Plus, Trash2, Pencil, LockKeyhole } from "lucide-react";
import { getSchema } from "@taskasaur/platform/core/catalog";
import {
  collectionColumns,
  tableStandard,
} from "@taskasaur/platform/core/collection-tables";
import {
  field,
  pgTypes,
  type Field,
  type Value,
} from "@taskasaur/platform/field-types";
import { Button } from "../ui/primitives/button";
import { Input } from "../ui/primitives/input";
import { Switch } from "../ui/primitives/switch";
import { ChoiceSelect } from "../ui/choice-select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "../ui/primitives/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/primitives/table";
import {
  createCollectionTable,
  tableDefinitions,
  selectedCollectionTable,
  tableSelectionKey,
} from "./collection-tables";
import type { AppRuntime } from "./runtime";

export function CollectionTablePicker({
  runtime,
  collection,
}: {
  runtime: AppRuntime;
  collection: string;
}) {
  const definitions =
    useLiveQuery(
      () => tableDefinitions(runtime, collection),
      [runtime, collection],
    ) ?? [];
  const selected = useLiveQuery(
    () => selectedCollectionTable(runtime, collection),
    [runtime, collection],
  );
  const [creating, setCreating] = useState(false),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2" data-table-picker>
      <ChoiceSelect
        aria-label="Data table"
        className="max-w-72"
        value={selected?.id ?? ""}
        options={definitions.map((t) => ({
          value: t.id,
          label: String(t.data.name),
        }))}
        onValueChange={(id) =>
          void runtime.db
            .setMetadata(tableSelectionKey(collection), id)
            .catch((e) => setError(String(e)))
        }
      />
      <Button
        variant="outline"
        disabled={!runtime.node.records.canWrite()}
        onClick={() => setCreating(true)}
      >
        <Plus />
        New table
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Create {getSchema(collection).name.toLowerCase()} table
            </DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                const table = await createCollectionTable(
                  runtime,
                  collection,
                  name,
                );
                await runtime.db.setMetadata(
                  tableSelectionKey(collection),
                  table.id,
                );
                setCreating(false);
                setName("");
                setError("");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <label className="field-row">
              Table name
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <Button type="submit">Create table</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
export function CollectionTableSettings({
  runtime,
  collection,
}: {
  runtime: AppRuntime;
  collection: string;
}) {
  const schema = getSchema(collection),
    standard = tableStandard(schema);
  const table = useLiveQuery(
    () => selectedCollectionTable(runtime, collection),
    [runtime, collection],
  );
  const [editing, setEditing] = useState<Field | "new" | null>(null),
    [preset, setPreset] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  if (!table)
    return (
      <p>Open this plugin after enabling it to create its default table.</p>
    );
  const columns = collectionColumns(schema, table.data.columns),
    presets = collectionColumns(schema);
  const writable = runtime.node.records.canWrite();
  const store = runtime.db
    .scoped({ ...runtime.principal, pluginId: schema.pluginId }, "tables")
    .collection("tables");
  const save = async (next: Field[]) => {
    setBusy(true);
    try {
      await store.put(
        { ...table.data, columns: next as unknown as Value },
        table.id,
      );
      setError("");
    } catch (error) {
      setError(String(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {standard.url ? (
          <a
            className="underline"
            href={standard.url}
            target="_blank"
            rel="noreferrer"
          >
            {standard.name}
          </a>
        ) : (
          standard.name
        )}
        . Required columns are locked. Other standard fields are optional
        presets. UID and DTSTAMP are generated automatically.
      </p>
      {collection === "reminders" && (
        <p className="text-sm text-muted-foreground">
          DISPLAY requires Description. EMAIL also requires Summary and
          Attendees. Relative triggers require a parent. Repeat and Duration
          must be used together; core validates these when saving an entry.
        </p>
      )}
      {collection === "mail" && (
        <p className="text-sm text-muted-foreground">
          Drafts can be incomplete. Sending validates the account and
          recipients; the mail library supplies the Date and From headers.
        </p>
      )}
      <form
        className="flex items-end gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          const name = new FormData(e.currentTarget).get("name");
          try {
            await store.put({ ...table.data, name: String(name) }, table.id);
            setError("");
          } catch (e) {
            setError(String(e));
          }
        }}
      >
        <label className="field-row flex-1">
          Table name
          <Input
            key={table.id + table.data.name}
            name="name"
            defaultValue={String(table.data.name)}
            required
            disabled={!writable || busy}
          />
        </label>
        <Button type="submit" variant="outline" disabled={!writable || busy}>
          Rename
        </Button>
      </form>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <div className="overflow-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Column</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Requirement</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {columns.map((column) => (
              <TableRow key={column.id}>
                <TableCell>
                  {column.label}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {column.id}
                  </span>
                </TableCell>
                <TableCell>
                  {column.pgType}
                  {column.array ? "[]" : ""}
                </TableCell>
                <TableCell>
                  {column.generated
                    ? "Generated"
                    : column.required
                      ? "Required"
                      : "Optional"}
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${column.label} column`}
                      disabled={!writable || busy}
                      onClick={() => setEditing(column)}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${column.label} column`}
                      disabled={
                        !writable ||
                        busy ||
                        standard.required.includes(column.id)
                      }
                      onClick={() =>
                        void save(
                          columns.filter((f) => f.id !== column.id),
                        ).catch(() => {})
                      }
                    >
                      {standard.required.includes(column.id) ? (
                        <LockKeyhole />
                      ) : (
                        <Trash2 />
                      )}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="flex flex-wrap gap-2">
        <ChoiceSelect
          aria-label="Standard column preset"
          disabled={!writable || busy}
          value={preset}
          options={presets
            .filter((p) => !columns.some((c) => c.id === p.id))
            .map((p) => ({ value: p.id, label: p.label }))}
          onValueChange={setPreset}
        />
        <Button
          variant="outline"
          disabled={!preset || !writable || busy}
          onClick={() => {
            const next = presets.find((p) => p.id === preset)!;
            setPreset("");
            void save([...columns, next]).catch(() => {});
          }}
        >
          Add preset
        </Button>
        <Button disabled={!writable || busy} onClick={() => setEditing("new")}>
          <Plus />
          Custom column
        </Button>
      </div>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Add custom column" : "Edit column"}
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <ColumnEditor
              key={editing === "new" ? "new" : editing.id}
              initial={editing === "new" ? undefined : editing}
              standard={
                editing !== "new" && presets.some((p) => p.id === editing.id)
              }
              onSave={async (next) => {
                if (
                  editing === "new" &&
                  (columns.some((c) => c.id === next.id) ||
                    presets.some((c) => c.id === next.id))
                )
                  throw Error(
                    "Use a distinct custom column ID, or add the standard preset.",
                  );
                await save(
                  editing === "new"
                    ? [...columns, next]
                    : columns.map((c) => (c.id === editing.id ? next : c)),
                );
                setEditing(null);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
function ColumnEditor({
  initial,
  standard,
  onSave,
}: {
  initial?: Field;
  standard: boolean;
  onSave: (field: Field) => Promise<void>;
}) {
  const [id, setId] = useState(initial?.id ?? ""),
    [label, setLabel] = useState(initial?.label ?? ""),
    [type, setType] = useState(initial?.pgType ?? "text"),
    [array, setArray] = useState(initial?.array ?? false),
    [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSave(
            field(id, label, type, { ...initial, label, pgType: type, array }),
          );
        } catch (e) {
          setError(String(e));
        }
      }}
    >
      <label className="field-row">
        Column ID
        <Input
          value={id}
          disabled={Boolean(initial)}
          required
          pattern="[a-z][a-z0-9_]*"
          onChange={(e) => setId(e.target.value)}
        />
      </label>
      <label className="field-row">
        Label
        <Input
          value={label}
          required
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>
      <label className="field-row">
        Base type
        <ChoiceSelect
          aria-label="Base type"
          disabled={standard}
          value={type}
          options={pgTypes.map((value) => ({ value, label: value }))}
          onValueChange={(value) => setType(value as typeof type)}
        />
      </label>
      <label className="flex gap-3">
        <Switch
          checked={array}
          disabled={standard}
          onCheckedChange={setArray}
        />
        List of values
      </label>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit">Save column</Button>
    </form>
  );
}
