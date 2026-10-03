import type { AppRuntime } from "./runtime";
import { schemaById } from "@taskasaur/platform/core/catalog";
import { fieldDescriptor, type Field } from "@taskasaur/platform/field-types";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import type {
  SearchDocument,
  SearchCollectionOptions,
} from "@taskasaur/platform/plugin-sdk/navigation";

export const searchText = (value: string) =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
const excluded =
  /password|secret|token|private_key|authorization|html|custom_fields/;
export function searchDocument(
  record: ResourceRecord,
  options?: SearchCollectionOptions,
  customFields: Field[] = [],
): SearchDocument | undefined {
  const schema = schemaById.get(record.collection);
  if (!schema || record.deletedAt || options?.enabled === false) return;
  const safeFields = [...schema.fields, ...customFields].filter(
    (f) =>
      !f.sensitive &&
      !excluded.test(f.id) &&
      f.control !== "password" &&
      f.pgType !== "bytea" &&
      f.pgType !== "jsonb",
  );
  const values = {
    ...record.data,
    ...((record.data.custom_fields as Record<
      string,
      import("@taskasaur/platform/field-types").Value
    >) ?? {}),
  };
  const fields = safeFields.filter(
    (f) => !options?.fields || options.fields.includes(f.id),
  );
  // Credential names/providers are searchable, never credentials or destination policies.
  const safe =
    record.collection === "credentials"
      ? fields.filter((f) => ["name", "provider"].includes(f.id))
      : fields;
  const titleIds = [
    options?.titleField,
    "title",
    "name",
    "subject",
    "summary",
    "description",
    "key",
  ];
  const titleField = titleIds.find(
    (id) => id && safe.some((f) => f.id === id) && values[id],
  );
  const title = String(
    titleField
      ? values[titleField]
      : schema.name + " · " + record.id.slice(0, 8),
  ).slice(0, 200);
  const text = safe
    .map((f) =>
      Array.isArray(values[f.id])
        ? (values[f.id] as unknown[]).join(" ")
        : String(values[f.id] ?? ""),
    )
    .join(" ")
    .slice(0, 48000);
  return {
    id: record.id,
    pluginId: record.pluginId,
    collection: record.collection,
    title,
    text,
    tokens: [
      ...new Set(
        searchText(title + " " + text).match(/[\p{L}\p{N}_-]+/gu) ?? [],
      ),
    ].slice(0, 5000),
    revision: JSON.stringify([
      record.updatedAt,
      record.revision,
      schema.version,
      options,
      title,
      text,
    ]),
  };
}
export class WorkspaceSearch {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private runtime: AppRuntime) {}
  refresh() {
    const task = this.queue.then(async () => {
      const runtime = this.runtime;
      const rows = await runtime.db.records.toArray();
      const old = new Map(
        (await runtime.db.searchDocuments.toArray()).map((d) => [d.id, d]),
      );
      const changed: SearchDocument[] = [],
        keep = new Set<string>();
      const tables = new Map(
        rows
          .filter((r) => r.collection === "tables" && !r.deletedAt)
          .map((r) => [r.id, r]),
      );
      for (const record of rows) {
        if (
          record.workspaceId !== runtime.profile.workspaceId ||
          !runtime.registry.enabled(record.pluginId)
        )
          continue;
        const parsed = fieldDescriptor
          .array()
          .safeParse(tables.get(String(record.data.table_id))?.data.columns);
        const document = searchDocument(
          record,
          runtime.searchOptions.get(record.collection),
          parsed.success
            ? parsed.data.filter(
                (f) =>
                  !schemaById
                    .get(record.collection)
                    ?.fields.some((base) => base.id === f.id),
              )
            : [],
        );
        if (!document) continue;
        keep.add(document.id);
        if (record.collection === "files" && record.data.version_id) {
          const cached = await runtime.db.fileVersions.get(
            String(record.data.version_id),
          );
          document.revision += ":bytes=" + Boolean(cached);
          if (
            cached &&
            old.get(document.id)?.revision !== document.revision &&
            cached.blob.size <= 4 * 1024 * 1024
          ) {
            const type = String(record.data.media_type ?? "");
            let extracted = "";
            if (type.startsWith("text/") && !/html|javascript/.test(type))
              extracted = await cached.blob.text();
            else if (type === "application/vnd.taskasaur.office+json") {
              try {
                const content = JSON.parse(await cached.blob.text());
                const strings: string[] = [];
                const visit = (value: unknown, key = "", depth = 0) => {
                  if (depth > 15) return;
                  if (
                    typeof value === "string" &&
                    ["insert", "text", "title", "notes"].includes(key)
                  )
                    strings.push(value);
                  else if (Array.isArray(value))
                    value.forEach((v) => visit(v, key, depth + 1));
                  else if (value && typeof value === "object")
                    for (const [k, v] of Object.entries(value))
                      visit(v, k, depth + 1);
                };
                visit(content);
                extracted = strings.join(" ");
              } catch {
                /* Index the metadata if a file is not valid office JSON. */
              }
            }
            document.text += " " + extracted.slice(0, 200000);
            document.tokens = [
              ...new Set(
                searchText(document.title + " " + document.text).match(
                  /[\p{L}\p{N}_-]+/gu,
                ) ?? [],
              ),
            ].slice(0, 20000);
          }
        }
        if (old.get(document.id)?.revision !== document.revision)
          changed.push(document);
      }
      await runtime.db.transaction(
        "rw",
        runtime.db.searchDocuments,
        runtime.db.records,
        runtime.db.fileVersions,
        async () => {
          await runtime.db.searchDocuments.bulkDelete(
            [...old.keys()].filter((id) => !keep.has(id)),
          );
          // Projection/retention can change while file text is extracted. Never restore
          // evicted content from the earlier search snapshot.
          const valid: SearchDocument[] = [];
          for (const document of changed) {
            const current = await runtime.db.records.get(document.id);
            const original = rows.find((r) => r.id === document.id);
            const bytesStillPresent =
              !document.revision.endsWith(":bytes=true") ||
              Boolean(
                current?.data.version_id &&
                (await runtime.db.fileVersions.get(
                  String(current.data.version_id),
                )),
              );
            if (
              current &&
              JSON.stringify(current) === JSON.stringify(original) &&
              bytesStillPresent
            )
              valid.push(document);
            else await runtime.db.searchDocuments.delete(document.id);
          }
          if (valid.length) await runtime.db.searchDocuments.bulkPut(valid);
        },
      );
    });
    this.queue = task.catch(() => {});
    return task;
  }
  async query(value: string, limit = 40) {
    await this.refresh();
    const terms = searchText(value).trim().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const documents = await this.runtime.db.searchDocuments
      .where("tokens")
      .startsWith(terms[0])
      .distinct()
      .toArray();
    return documents
      .map((document) => {
        const title = searchText(document.title),
          text = searchText(document.text);
        const score = terms.every((t) => title.includes(t) || text.includes(t))
          ? terms.reduce(
              (sum, term) =>
                sum +
                (title === term
                  ? 20
                  : title.startsWith(term)
                    ? 10
                    : title.includes(term)
                      ? 5
                      : 1),
              0,
            )
          : 0;
        return { ...document, score };
      })
      .filter((d) => d.score > 0)
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
      .slice(0, limit);
  }
}
