import { describe, it, expect } from "vitest";
import {
  field,
  decodeField,
  validateRecord,
  queryRecords,
  legacyTypes,
} from "../packages/field-types";
describe("PostgreSQL field contract", () => {
  it("preserves precision for bigint/decimal and sorts exact values", () => {
    const big = field("n", "Number", "bigint");
    expect(decodeField(big, "9223372036854775807")).toBe("9223372036854775807");
    expect(() => decodeField(big, "9223372036854775808")).toThrow();
    expect(() => decodeField(big, 9007199254740993)).toThrow();
    const decimal = field("n", "Number", "numeric", {
      precision: 18,
      scale: 6,
    });
    expect(decodeField(decimal, "-0.001200")).toBe("-0.0012");
    expect(() => decodeField(decimal, "1.0000001")).toThrow();
    const schema = {
      id: "test",
      pluginId: "test",
      name: "Test",
      version: 1,
      fields: [big],
    };
    const rows = [
      { id: "a", data: { n: "9007199254740993" } },
      { id: "b", data: { n: "9007199254740992" } },
    ];
    expect(
      queryRecords(rows, schema, {
        sorts: [{ field: "n", direction: "asc", enabled: true }],
      }).map((x) => x.id),
    ).toEqual(["b", "a"]);
  });
  it("distinguishes dates, instants, wall times, null, and absent required input", () => {
    expect(() =>
      decodeField(field("d", "Date", "date"), "2025-02-29"),
    ).toThrow();
    expect(decodeField(field("d", "Date", "date"), "2024-02-29")).toBe(
      "2024-02-29",
    );
    expect(() =>
      decodeField(
        field("d", "Date", "timestamp with time zone"),
        "2026-10-01T12:00:00",
      ),
    ).toThrow();
    expect(() =>
      decodeField(
        field("d", "Date", "timestamp without time zone"),
        "2026-10-01T12:00:00Z",
      ),
    ).toThrow();
    const schema = {
      id: "test",
      pluginId: "test",
      name: "Test",
      version: 1,
      fields: [
        field("s", "String", "text", { required: true, nullable: false }),
      ],
    };
    expect(() => validateRecord(schema, {})).toThrow();
    expect(() => validateRecord(schema, { s: null })).toThrow();
    expect(validateRecord(schema, { s: "" })).toEqual({ s: "" });
    expect(() => validateRecord(schema, { s: "x", token: "secret" })).toThrow();
  });
  it("accounts for all eleven legacy field kinds without parsing Markdown", () => {
    expect(Object.keys(legacyTypes)).toHaveLength(11);
    expect(legacyTypes.markdown).toEqual({
      pgType: "text",
      control: "textarea",
    });
  });
});
