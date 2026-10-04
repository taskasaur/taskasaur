import { expect, it } from "vitest";
import { field, decodeField } from "@taskasaur/platform/field-types";
import {
  tableFields,
  validateTableValues,
} from "@taskasaur/platform/core/dynamic-fields";
import { collectionColumns } from "@taskasaur/platform/core/collection-tables";
import { getSchema } from "@taskasaur/platform/core/catalog";
it("keeps scalar type separate from input count and selection options", () => {
  const column = field("scores", "Scores", "integer", {
    array: true,
    inputMode: "multiselect",
    options: [1, 2, 3],
    minItems: 1,
    maxItems: 2,
    default: [1],
    visibility: "editable",
  });
  expect(tableFields([column])).toEqual([column]);
  expect(decodeField(column, [1, 3])).toEqual([1, 3]);
  expect(() => decodeField(column, [1, 1])).toThrow("once");
  expect(() => decodeField(column, [1, 2, 3])).toThrow("too many");
  expect(() => decodeField(column, [])).toThrow("too few");
  expect(() => decodeField(column, ["1"])).toThrow();
  expect(() => decodeField(column, [9])).toThrow("declared option");
  expect(() => tableFields([{ ...column, array: false }])).toThrow(
    "Input count",
  );
});
it("retains values after removing a user column and validates them when it returns", () => {
  const original = { title: "Keep me", count: 3 };
  const hidden = validateTableValues(
    [field("count", "Count", "integer")],
    original,
  );
  expect(hidden).toEqual(original);
  expect(
    validateTableValues(
      [field("title", "Title"), field("count", "Count", "integer")],
      hidden,
    ),
  ).toEqual(original);
  expect(() =>
    validateTableValues([field("title", "Title", "integer")], hidden),
  ).toThrow();
});
it("allows independent template copies but preserves required standard contracts", () => {
  const schema = getSchema("tasks"),
    required = collectionColumns(schema).filter((f) => f.required);
  expect(collectionColumns(schema, required).map((f) => f.id)).toEqual(
    expect.arrayContaining(["uid", "dtstamp"]),
  );
  const template = field("title", "My score", "integer", {
    storage: "custom",
    inputMode: "single",
    default: 3,
  });
  expect(
    collectionColumns(schema, [...required, template]).at(-1)?.pgType,
  ).toBe("integer");
  expect(() =>
    collectionColumns(
      schema,
      required.map((f) =>
        f.id === "uid" ? { ...f, storage: "custom", pgType: "integer" } : f,
      ),
    ),
  ).toThrow();
  expect(tableFields([])).toEqual([]);
});
it("mirrors standard-compatible template changes for plugin interoperability", async () => {
  const { DeviceCore } = await import("../packages/core/device");
  const { MemoryStorage } = await import("../packages/storage");
  const device = await DeviceCore.open(new MemoryStorage(), "Templates");
  const node = await device.createWorkspace("Fields"),
    schema = getSchema("tasks");
  const columns = [
    ...collectionColumns(schema).filter((f) => f.required),
    field("title", "Title", "text", { storage: "custom" }),
    field("status", "Status", "text", {
      storage: "custom",
      inputMode: "select",
      options: ["open", "done"],
    }),
  ];
  const table = await node.records.put(
    "tables",
    { name: "Tasks", collection_id: "tasks", is_default: false, columns },
    undefined,
    { managedBy: "tasks" },
  );
  const task = await node.records.put("tasks", {
    table_id: table.id,
    custom_fields: { title: "Portable title", status: "open" },
  });
  expect(task.data.title).toBe("Portable title");
  const completed = await node.records.put(
    "tasks",
    { ...task.data, status: "done" },
    task.id,
  );
  expect(completed.data.custom_fields).toMatchObject({ status: "done" });
  const renamed = await node.records.put(
    "tasks",
    {
      ...completed.data,
      custom_fields: { title: "New title", status: "done" },
    },
    task.id,
  );
  expect(renamed.data.title).toBe("New title");
  await device.close();
});
