import {
  compareValues,
  decodeField,
  type Field,
  type Query,
  type Value,
  type RecordSchema,
} from "@taskasaur/platform/field-types";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";

export const viewModes = [
  "short-table",
  "long-table",
  "board",
  "short-table-folder",
  "long-table-folder",
  "board-folder",
] as const;
export type ViewMode = (typeof viewModes)[number];
export const viewLabels: Record<ViewMode, string> = {
  "short-table": "Short table",
  "long-table": "Long table",
  board: "Board",
  "short-table-folder": "Short table folder",
  "long-table-folder": "Long table folder",
  "board-folder": "Board folder",
};
export interface Grouping {
  id: string;
  field: string;
  enabled: boolean;
}
export interface GroupSegment {
  field: string;
  key: string;
}
export interface CollectionViewState {
  version: 2;
  query: Query;
  columns: string[];
  groups: Grouping[];
  mode: ViewMode;
  path: GroupSegment[];
  collapsed: string[];
}
export interface GroupNode {
  id: string;
  field: Field;
  value: Value;
  path: GroupSegment[];
  rows: ResourceRecord[];
  children: GroupNode[];
}

/** Display preferences are local; search from older table preferences is deliberately retired. */
export function normalizeView(
  saved: Partial<CollectionViewState> | undefined,
  schema: RecordSchema,
): CollectionViewState {
  const ids = new Set(schema.fields.map((f) => f.id));
  const query = saved?.query ?? {};
  const { search: _search, groupBy, ...rest } = query;
  const groups =
    saved?.groups ??
    (groupBy && ids.has(groupBy)
      ? [{ id: "legacy-" + groupBy, field: groupBy, enabled: true }]
      : []);
  return {
    version: 2,
    query: {
      ...rest,
      filters: rest.filters?.filter((f) => ids.has(f.field)),
      sorts: rest.sorts?.filter((s) => ids.has(s.field)),
    },
    columns: [
      ...new Set(
        (saved?.columns ?? schema.fields.slice(0, 5).map((f) => f.id)).filter(
          (id) => ids.has(id),
        ),
      ),
    ],
    groups: groups.filter((g) => ids.has(g.field)),
    mode: viewModes.includes(saved?.mode as ViewMode)
      ? saved!.mode!
      : "short-table",
    path: saved?.path ?? [],
    collapsed: saved?.collapsed ?? [],
  };
}
export function moveRule<T>(rules: T[], index: number, direction: -1 | 1): T[] {
  const to = index + direction;
  if (to < 0 || to >= rules.length) return rules;
  const next = [...rules];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}
function canonical(value: Value): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export function groupKey(field: Field, value: Value | undefined): string {
  if (value == null) return "null";
  let normalized: Value = value;
  try {
    normalized = decodeField(field, value);
  } catch {
    /* Opaque newer values remain visible. */
  }
  if (field.array && Array.isArray(normalized))
    return (
      "[" +
      normalized.map((v) => groupKey({ ...field, array: false }, v)).join(",") +
      "]"
    );
  if (
    (field.pgType === "numeric" || field.pgType === "bigint") &&
    /^-?\d+(\.\d+)?$/.test(String(normalized))
  ) {
    const [whole, fraction = ""] = String(normalized).split(".");
    const decimals = fraction.replace(/0+$/, "");
    const integer = BigInt(whole).toString();
    return JSON.stringify(
      (String(normalized).startsWith("-") && integer === "0" && decimals
        ? "-"
        : "") +
        integer +
        (decimals ? "." + decimals : ""),
    );
  }
  if (
    field.pgType === "timestamp with time zone" &&
    Number.isFinite(Date.parse(String(normalized)))
  ) {
    return JSON.stringify(
      (
        BigInt(Date.parse(String(normalized))) * 1000n +
        BigInt(
          (String(normalized).match(/\.(\d+)/)?.[1] ?? "")
            .padEnd(6, "0")
            .slice(3, 6),
        )
      ).toString(),
    );
  }
  return canonical(normalized);
}
export function activeGroups(groups: Grouping[], fields: Field[]): Field[] {
  const seen = new Set<string>();
  return groups.flatMap((g) => {
    const field = fields.find((f) => f.id === g.field);
    if (!g.enabled || !field || seen.has(g.field)) return [];
    seen.add(g.field);
    return [field];
  });
}
export function groupRecords(
  rows: ResourceRecord[],
  fields: Field[],
  depth = 0,
  parent: GroupSegment[] = [],
): GroupNode[] {
  const field = fields[depth];
  if (!field) return [];
  const buckets = new Map<string, { value: Value; rows: ResourceRecord[] }>();
  for (const row of rows) {
    const value = row.data[field.id] ?? null,
      key = groupKey(field, value);
    const bucket = buckets.get(key) ?? { value, rows: [] };
    bucket.rows.push(row);
    buckets.set(key, bucket);
  }
  return [...buckets]
    .sort((a, b) => compareValues(field, a[1].value, b[1].value))
    .map(([key, bucket]) => {
      const path = [...parent, { field: field.id, key }];
      return {
        id: JSON.stringify(path),
        field,
        value: bucket.value,
        path,
        rows: bucket.rows,
        children: groupRecords(bucket.rows, fields, depth + 1, path),
      };
    });
}
/** Resolve the longest valid prefix after changes to grouping, filters or data. */
export function resolveGroupPath(
  tree: GroupNode[],
  path: GroupSegment[],
): { ancestors: GroupNode[]; children: GroupNode[] } {
  const ancestors: GroupNode[] = [];
  let children = tree;
  for (const segment of path) {
    const node = children.find(
      (n) => n.field.id === segment.field && n.path.at(-1)?.key === segment.key,
    );
    if (!node) break;
    ancestors.push(node);
    children = node.children;
  }
  return { ancestors, children };
}
