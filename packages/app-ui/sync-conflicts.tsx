"use client";
import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { AppRuntime } from "./runtime";
import { getSchema } from "@taskasaur/platform/core/catalog";
import { displayValue } from "../ui/fields";
import { Button } from "../ui/primitives/button";
import { download } from "./productivity";
export function SyncConflicts({ runtime }: { runtime: AppRuntime }) {
  const entries =
      useLiveQuery(
        () =>
          runtime.db.outbox
            .where("state")
            .anyOf("conflict", "rejected")
            .toArray(),
        [runtime],
      ) ?? [],
    versions =
      useLiveQuery(
        () =>
          runtime.db.fileVersions
            .filter((v) => Boolean(v.error) && !v.recoveryFileId)
            .toArray(),
        [runtime],
      ) ?? [],
    records = useLiveQuery(() => runtime.db.records.toArray(), [runtime]) ?? [];
  const [error, setError] = useState("");
  const conflicts = entries.filter(
    (entry, index) =>
      entries.findIndex((other) => other.resourceId === entry.resourceId) ===
      index,
  );
  if (!conflicts.length && !versions.length) return null;
  return (
    <section className="settings-card space-y-4">
      <h2>Synchronization needs attention</h2>
      {error && <p role="alert">{error}</p>}
      {conflicts.map((entry) => {
        const local = records.find((r) => r.id === entry.resourceId),
          server = entry.serverRecord,
          schema = getSchema(entry.collection);
        return (
          <article key={entry.id} className="rounded-lg border p-4 space-y-3">
            <p className="font-medium">
              {schema.name}:{" "}
              {String(
                local?.data.title ??
                  local?.data.name ??
                  local?.data.subject ??
                  entry.resourceId,
              )}
            </p>
            <p className="text-sm">{entry.error}</p>
            {server && local && (
              <div className="overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>On this device</th>
                      <th>On server</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.fields
                      .filter(
                        (f) =>
                          JSON.stringify(local.data[f.id]) !==
                          JSON.stringify(server.data[f.id]),
                      )
                      .map((f) => (
                        <tr key={f.id}>
                          <td>{f.label}</td>
                          <td className="max-w-72 break-words p-2">
                            {displayValue(local.data[f.id], f)}
                          </td>
                          <td className="max-w-72 break-words p-2">
                            {displayValue(server.data[f.id], f)}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {server &&
                entry.state === "conflict" &&
                (["server", "local"] as const).map((resolution) => (
                  <Button
                    key={resolution}
                    variant="outline"
                    disabled={
                      resolution === "local" && Boolean(server.deletedAt)
                    }
                    onClick={async () => {
                      try {
                        await runtime.db.resolveConflict(
                          entry.resourceId,
                          resolution,
                          server.revision,
                        );
                        await runtime.synchronize();
                        setError("");
                      } catch (e) {
                        setError(String(e));
                      }
                    }}
                  >
                    {resolution === "server"
                      ? "Use server values"
                      : "Keep local values"}
                  </Button>
                ))}
              {local && (
                <Button
                  variant="ghost"
                  onClick={() =>
                    download(
                      "local-recovery.json",
                      new Blob(
                        [
                          JSON.stringify(
                            { collection: local.collection, data: local.data },
                            null,
                            2,
                          ),
                        ],
                        { type: "application/json" },
                      ),
                    )
                  }
                >
                  Export local values
                </Button>
              )}
            </div>
          </article>
        );
      })}
      {versions.map((version) => (
        <article key={version.id} className="rounded-lg border p-4 space-y-2">
          <p>File version {version.id}</p>
          <p className="text-sm">{version.error}</p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() =>
                download(
                  String(
                    records.find((r) => r.id === version.fileId)?.data.name ??
                      "recovered-file",
                  ),
                  version.blob,
                )
              }
            >
              Download local file
            </Button>
            <Button
              variant="outline"
              onClick={async () => {
                try {
                  const old = records.find((r) => r.id === version.fileId);
                  if (!old) throw new Error("File metadata unavailable");
                  const copy = await runtime.collection("files").put({
                    name: String(old.data.name) + " (recovered)",
                    media_type: old.data.media_type,
                    size: String(version.blob.size),
                  });
                  await runtime.db.saveFile(
                    runtime.principal,
                    copy.id,
                    version.blob,
                    null,
                  );
                  await runtime.db.fileVersions.update(version.id, {
                    recoveryFileId: copy.id,
                  });
                  const server = await runtime.api<
                    import("@taskasaur/platform/plugin-sdk").ResourceRecord
                  >("records/get?id=" + version.fileId);
                  await runtime.db.ingest(
                    [server],
                    (await runtime.db.getMetadata<string>("sync.cursor")) ??
                      "0",
                  );
                  await runtime.synchronize();
                } catch (e) {
                  setError(String(e));
                }
              }}
            >
              Save as a separate file
            </Button>
          </div>
        </article>
      ))}
    </section>
  );
}
