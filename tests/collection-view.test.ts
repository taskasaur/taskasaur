import { expect, it } from "vitest";
import type {
  Field,
  RecordSchema,
  Value,
} from "@taskasaur/platform/field-types";
import type { ResourceRecord } from "@taskasaur/platform/plugin-sdk";
import {
  activeGroups,
  groupKey,
  groupRecords,
  moveRule,
  normalizeView,
  resolveGroupPath,
} from "../packages/ui/collection-view-model";
const field = (id: string, pgType: Field["pgType"] = "text"): Field => ({
  id,
  label: id,
  pgType,
  nullable: true,
  array: false,
  required: false,
  sensitive: false,
});
const fields = [field("status"), field("priority", "bigint")];
const schema = {
  id: "test",
  name: "Entries",
  version: 1,
  pluginId: "test",
  fields,
} as RecordSchema;
const row = (id: string, status: Value, priority: Value): ResourceRecord =>
  ({ id, data: { status, priority } }) as unknown as ResourceRecord;
it("groups recursively, retains leaf sort order and resolves only valid breadcrumb prefixes", () => {
  const rows = [
    row("a", "open", "9007199254740993"),
    row("b", "open", "9007199254740992"),
    row("c", "done", null),
    row("d", "open", "9007199254740992"),
  ];
  const tree = groupRecords(rows, fields),
    open = tree.find((n) => n.value === "open")!;
  expect(open.children.map((n) => n.value)).toEqual([
    "9007199254740992",
    "9007199254740993",
  ]);
  expect(open.children[0].rows.map((r) => r.id)).toEqual(["b", "d"]);
  const path = open.children[0].path;
  expect(resolveGroupPath(tree, path).ancestors).toHaveLength(2);
  expect(
    resolveGroupPath(
      groupRecords(
        rows.filter((r) => !["b", "d"].includes(r.id)),
        fields,
      ),
      path,
    ).ancestors,
  ).toHaveLength(1);
  expect(
    resolveGroupPath(groupRecords(rows, [fields[1], fields[0]]), path)
      .ancestors,
  ).toHaveLength(0);
});
it("uses typed, stable keys without decimal or microsecond precision loss", () => {
  expect(groupKey(fields[1], "09007199254740993")).toBe(
    groupKey(fields[1], "9007199254740993"),
  );
  expect(groupKey(fields[1], "9007199254740992")).not.toBe(
    groupKey(fields[1], "9007199254740993"),
  );
  const numeric = field("number", "numeric"),
    instant = field("time", "timestamp with time zone");
  expect(groupKey(numeric, "1.00")).toBe(groupKey(numeric, "1"));
  expect(groupKey(numeric, "-0.500")).toBe(groupKey(numeric, "-0.5"));
  expect(groupKey(numeric, "-0.5")).not.toBe(groupKey(numeric, "0.5"));
  expect(groupKey(instant, "2026-01-01T01:00:00.123456+01:00")).toBe(
    groupKey(instant, "2026-01-01T00:00:00.123456Z"),
  );
  expect(groupKey(instant, "2026-01-01T00:00:00.123456Z")).not.toBe(
    groupKey(instant, "2026-01-01T00:00:00.123457Z"),
  );
  const json = field("json", "jsonb");
  expect(groupKey(json, { b: 2, a: 1 })).toBe(groupKey(json, { a: 1, b: 2 }));
  expect(groupKey(fields[0], null)).not.toBe(groupKey(fields[0], "null"));
  expect(
    groupRecords([row("a", null, null), row("b", null, null)], fields),
  ).toHaveLength(1);
});
it("migrates old preferences, clears retired search and ignores absent schema fields", () => {
  const state = normalizeView(
    {
      query: {
        search: "invisible old search",
        groupBy: "status",
        sorts: [{ field: "missing", direction: "asc", enabled: true }],
      },
      columns: ["status", "missing", "status"],
    },
    schema,
  );
  expect(state.query).not.toHaveProperty("search");
  expect(state.query).not.toHaveProperty("groupBy");
  expect(state.groups).toEqual([
    { id: "legacy-status", field: "status", enabled: true },
  ]);
  expect(state.columns).toEqual(["status"]);
  expect(state.query.sorts).toEqual([]);
  expect(normalizeView({ columns: [] }, schema).columns).toEqual([]);
});
it("reorders enabled grouping rules without mutating the original, and ignores duplicates", () => {
  const groups = [
    { id: "a", field: "status", enabled: false },
    { id: "b", field: "priority", enabled: true },
    { id: "c", field: "status", enabled: true },
  ];
  expect(activeGroups(groups, fields).map((f) => f.id)).toEqual([
    "priority",
    "status",
  ]);
  const moved = moveRule(groups, 2, -1);
  expect(activeGroups(moved, fields).map((f) => f.id)).toEqual([
    "status",
    "priority",
  ]);
  expect(groups[2].id).toBe("c");
  expect(moveRule(groups, 0, -1)).toEqual(groups);
});
