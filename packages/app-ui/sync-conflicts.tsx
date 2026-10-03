import { useState, useSyncExternalStore } from "react";
import type { AppRuntime } from "./runtime";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { Button } from "../ui/primitives/button";
import { download } from "./download";
export function SyncConflicts({ runtime }: { runtime: AppRuntime }) {
  useSyncExternalStore(
    (listener) => {
      runtime.surfaceListeners.add(listener);
      return () => {
        runtime.surfaceListeners.delete(listener);
      };
    },
    () => runtime.surfacesVersion,
    () => 0,
  );
  const [error, setError] = useState(""),
    replica = runtime.node.replica;
  const conflicts = runtime.node.records.all().flatMap((record) =>
    [
      ...Object.keys(record.data).map((field) => ({ field, nested: true })),
      { field: "deletedAt", nested: false },
    ].flatMap(({ field, nested }) => {
      const values = replica.conflicts("record/" + record.id, field, nested);
      return Object.keys(values).length > 1
        ? [{ record, field, nested, values }]
        : [];
    }),
  );
  if (!conflicts.length) return null;
  return (
    <section className="settings-card space-y-4">
      <h2>Concurrent changes</h2>
      <p>
        Independent fields merge automatically. Choose which value to keep when
        devices changed the same field. All file versions remain available.
      </p>
      {error && <p role="alert">{error}</p>}
      {conflicts.map(({ record, field, nested, values }) => (
        <article
          className="border rounded-lg p-4 space-y-3"
          key={record.id + field}
        >
          <p>
            {String(record.data.title ?? record.data.name ?? record.id)} ·{" "}
            {schemaById
              .get(record.collection)
              ?.fields.find((f) => f.id === field)?.label ?? field}
          </p>
          {Object.entries(values).map(([operation, value]) => (
            <div key={operation} className="flex items-center gap-3">
              <pre className="text-xs whitespace-pre-wrap break-all flex-1">
                {JSON.stringify(value)}
              </pre>
              <Button
                variant="outline"
                disabled={!runtime.node.records.canWrite()}
                onClick={async () => {
                  try {
                    const current = replica.read<Record<string, any>>(
                      "record/" + record.id,
                    )!;
                    if (nested) current.data[field] = value;
                    else current[field] = value;
                    await replica.update("record/" + record.id, current, [
                      nested ? "data." + field : field,
                    ]);
                    await runtime.project();
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              >
                Keep this value
              </Button>
              {field === "version_id" && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      const file = await runtime.node.protocol.files.read(
                        String(value),
                      );
                      download(
                        String(record.data.name),
                        new Blob([new Uint8Array(file.bytes)], {
                          type: file.manifest.mediaType,
                        }),
                      );
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Download version
                </Button>
              )}
            </div>
          ))}
        </article>
      ))}
    </section>
  );
}
