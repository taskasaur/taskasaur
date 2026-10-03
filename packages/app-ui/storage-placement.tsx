import { useEffect, useState } from "react";
import { HardDrive, RefreshCw } from "lucide-react";
import type { AppRuntime } from "./runtime";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type { StorageItemStatus } from "@taskasaur/platform/plugin-sdk/storage-placement";
import { currentPolicy } from "../core/identity";
import {
  essentialCollections,
  itemKey as keyFor,
} from "../core/storage-placement";
import { Button } from "../ui/primitives/button";
import { Switch } from "../ui/primitives/switch";
import { Input } from "../ui/primitives/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/primitives/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "../ui/primitives/table";

export function StorageCopiesButton({
  runtime,
  record,
}: {
  runtime: AppRuntime;
  record: ResourceRecord;
}) {
  if (
    essentialCollections.has(record.collection) &&
    record.collection !== "files"
  )
    return null;
  if (record.collection === "files" && record.data.is_folder) return null;
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Storage copies"
      onClick={() => {
        const item =
          record.collection === "files"
            ? "file." + record.id
            : keyFor({ kind: "record", id: record.id });
        location.hash = "settings:storage?item=" + encodeURIComponent(item);
      }}
    >
      <HardDrive />
    </Button>
  );
}

export function StoragePlacementView({
  runtime,
  itemKey,
}: {
  runtime: AppRuntime;
  itemKey?: string;
}) {
  const storage = runtime.node.protocol.storage;
  const [items, setItems] = useState<StorageItemStatus[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [search, setSearch] = useState(""),
    [review, setReview] = useState<StorageItemStatus>();
  const members = Object.entries(
    currentPolicy(runtime.node.replica.access).members,
  );
  const editable = runtime.node.replica.member.role !== "viewer";
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void storage
        .list()
        .then((rows) => {
          if (alive) setItems(rows);
        })
        .catch((e) => {
          if (alive) setError(String(e));
        });
    };
    refresh();
    storage.listeners.add(refresh);
    runtime.node.replica.listeners.add(refresh);
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
      storage.listeners.delete(refresh);
      runtime.node.replica.listeners.delete(refresh);
    };
  }, [runtime, storage]);
  async function update(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
      await runtime.synchronize();
      setItems(await storage.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const rows = items.filter((row) => {
    if (itemKey?.startsWith("file.")) {
      if (
        row.item.kind !== "file-version" ||
        runtime.node.protocol.files
          .manifests()
          .find((m) => m.id === row.item.id)?.fileId !== itemKey.slice(5)
      )
        return false;
    } else if (itemKey && keyFor(row.item) !== itemKey) return false;
    return `${row.label} ${row.pluginId} ${row.collection}`
      .toLowerCase()
      .includes(search.toLowerCase());
  });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="font-semibold">Storage copies</h2>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => void update(async () => {})}
        >
          <RefreshCw className="size-4" />
          Synchronize
        </Button>
        {itemKey && (
          <Button
            variant="ghost"
            onClick={() => {
              location.hash = "settings:storage";
            }}
          >
            All items
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Choose which devices keep each record or file version. Offline changes
        wait for reconnection. A copy stays until another device confirms it has
        this exact version, unless you explicitly delete it.
      </p>
      <p className="text-xs text-muted-foreground">
        Workspace permissions, table definitions, file and credential metadata
        remain on every device. Record history moves with the record. Verified
        copies describe the last acknowledgement; a device may currently be
        offline.
      </p>
      <Input
        aria-label="Find storage items"
        placeholder="Find storage items"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Item / version</TableHead>
            {members.map(([id, member]) => (
              <TableHead key={id}>
                {member.identity.name}
                {id === runtime.node.replica.identity.id
                  ? " (this device)"
                  : ""}
                <span className="block text-xs font-normal text-muted-foreground">
                  {id === runtime.node.replica.identity.id ||
                  Date.now() -
                    (runtime.node.peerDevices.get(id)?.lastSeen ?? 0) <
                    45000
                    ? "Online"
                    : "Offline"}
                </span>
              </TableHead>
            ))}
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={keyFor(row.item)}>
              <TableCell>
                <span className="font-medium">{row.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {row.pluginId} ·{" "}
                  {row.item.kind === "record"
                    ? "Record + history"
                    : "File version"}{" "}
                  · {row.version.token.slice(0, 8)}
                  {row.deleted ? " · Deletion requested" : ""}
                </span>
              </TableCell>
              {members.map(([id, member]) => {
                const copy = row.copies.find((c) => c.deviceId === id)!;
                return (
                  <TableCell key={id}>
                    <Switch
                      aria-label={`Keep ${row.label} on ${member.identity.name}`}
                      checked={copy.requested}
                      disabled={!editable || busy || row.deleted}
                      onCheckedChange={(keep) =>
                        void update(async () => {
                          await storage.setCopy(row.item, id, keep);
                          if (
                            !keep &&
                            !row.copies.some(
                              (c) =>
                                c.deviceId !== id && c.requested && c.retained,
                            )
                          )
                            setReview(await storage.status(row.item));
                        })
                      }
                    />
                    <span className="block text-xs text-muted-foreground">
                      {copy.retained
                        ? copy.requested
                          ? "Verified copy"
                          : "Retained until safe handoff"
                        : copy.requested
                          ? "Waiting for copy"
                          : "No copy requested"}
                    </span>
                  </TableCell>
                );
              })}
              <TableCell>
                {editable && !row.deleted && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setReview(row)}
                  >
                    Delete version…
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
          {!rows.length && (
            <TableRow>
              <TableCell colSpan={members.length + 2}>
                No matching stored items.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <Dialog
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReview(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keep a copy or delete this version?</DialogTitle>
            <DialogDescription>
              Turning off copies does not delete the last retained version. Keep
              it while waiting for another device, or explicitly delete the
              reviewed version of “{review?.label}” from every device when they
              next connect. For a record, this removes its entire history at
              these heads. Offline edits with different heads are preserved and
              need a separate review.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-muted-foreground break-all">
            Reviewed version: {review?.version.token}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReview(undefined)}>
              Keep pending copies
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const chosen = review!;
                void update(async () => {
                  await storage.deleteVersion(
                    chosen.item,
                    chosen.version.token,
                  );
                  setReview(undefined);
                });
              }}
            >
              Delete this version everywhere
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
