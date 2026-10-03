import { z } from "zod";
import { CoreError, invariant } from "../core/errors";

export const pgTypes = [
  "text",
  "character varying",
  "uuid",
  "boolean",
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "double precision",
  "date",
  "time without time zone",
  "timestamp without time zone",
  "timestamp with time zone",
  "interval",
  "jsonb",
  "bytea",
] as const;
export type PgType = (typeof pgTypes)[number];
export type Value =
  string | number | boolean | null | Value[] | { [key: string]: Value };
export const fieldDescriptor = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  pgType: z.enum(pgTypes),
  required: z.boolean().default(false),
  nullable: z.boolean().default(true),
  array: z.boolean().default(false),
  length: z.number().int().positive().optional(),
  precision: z.number().int().min(1).max(1000).optional(),
  scale: z.number().int().min(0).max(1000).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  choices: z.array(z.string()).optional(),
  default: z.unknown().optional(),
  control: z
    .enum([
      "text",
      "textarea",
      "email",
      "url",
      "path",
      "password",
      "select",
      "reference",
      "color",
    ])
    .optional(),
  reference: z.string().optional(),
  description: z.string().optional(),
  sensitive: z.boolean().default(false),
});
export type Field = z.infer<typeof fieldDescriptor>;
export interface RecordSchema {
  id: string;
  pluginId: string;
  name: string;
  version: number;
  fields: Field[];
  standard?: "ical-event" | "ical-alarm" | "time-interval";
  validate?: (data: Record<string, Value>) => void;
}
export function field(
  id: string,
  label: string,
  pgType: PgType = "text",
  options: Partial<Field> = {},
): Field {
  return fieldDescriptor.parse({ id, label, pgType, ...options });
}
export function sqlIdentifier(value: string) {
  invariant(
    /^[a-z][a-z0-9_]*$/.test(value),
    "VALIDATION_FAILED",
    "Invalid SQL identifier",
  );
  return `"${value}"`;
}
export function sqlType(f: Field): string {
  invariant(
    pgTypes.includes(f.pgType),
    "VALIDATION_FAILED",
    "Unsupported PostgreSQL type",
  );
  const type =
    f.pgType === "numeric" && f.precision
      ? `numeric(${f.precision},${f.scale ?? 0})`
      : f.pgType === "character varying" && f.length
        ? `character varying(${f.length})`
        : f.pgType;
  return type + (f.array ? "[]" : "");
}
function fail(f: Field, reason: string): never {
  throw new CoreError("VALIDATION_FAILED", `${f.label}: ${reason}`, {
    field: f.id,
  });
}
function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
function validClock(value: string) {
  return /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?$/.test(value);
}
function validateJson(value: unknown, depth = 0): Value {
  invariant(depth <= 40, "VALIDATION_FAILED", "JSON nesting is too deep");
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((v) => validateJson(v, depth + 1));
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        invariant(
          !["__proto__", "prototype", "constructor"].includes(key),
          "VALIDATION_FAILED",
          "Reserved JSON key",
        );
        return [key, validateJson(v, depth + 1)];
      }),
    );
  }
  throw new CoreError("VALIDATION_FAILED", "Expected a finite JSON value");
}
export function decodeField(f: Field, value: unknown): Value {
  if (value === null) {
    if (!f.nullable) fail(f, "a value is required");
    return null;
  }
  if (f.array) {
    if (!Array.isArray(value)) fail(f, "expected a list");
    return value.map((v) =>
      decodeField({ ...f, array: false, nullable: false }, v),
    );
  }
  if (f.pgType === "jsonb") return validateJson(value);
  if (f.pgType === "boolean") {
    if (typeof value !== "boolean") fail(f, "expected true or false");
    return value;
  }
  if (["smallint", "integer", "double precision"].includes(f.pgType)) {
    if (typeof value !== "number" || !Number.isFinite(value))
      fail(f, "expected a finite number");
    if (f.pgType !== "double precision" && !Number.isInteger(value))
      fail(f, "expected an integer");
    const bounds =
      f.pgType === "smallint"
        ? [-32768, 32767]
        : f.pgType === "integer"
          ? [-2147483648, 2147483647]
          : [-Infinity, Infinity];
    if (
      value < Math.max(bounds[0], f.min ?? -Infinity) ||
      value > Math.min(bounds[1], f.max ?? Infinity)
    )
      fail(f, "outside the allowed range");
    return value;
  }
  if (typeof value !== "string") fail(f, "expected a string");
  if (f.length && [...value].length > f.length)
    fail(f, `maximum length is ${f.length}`);
  if (f.choices && !f.choices.includes(value))
    fail(f, "choose a declared option");
  switch (f.pgType) {
    case "uuid":
      if (!z.string().uuid().safeParse(value).success) fail(f, "invalid UUID");
      return value.toLowerCase();
    case "bigint": {
      if (!/^-?(0|[1-9]\d*)$/.test(value))
        fail(f, "expected an exact integer string");
      const integer = BigInt(value);
      if (integer < -9223372036854775808n || integer > 9223372036854775807n)
        fail(f, "outside PostgreSQL bigint range");
      return integer.toString();
    }
    case "numeric": {
      if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(value))
        fail(f, "expected an exact decimal string");
      const [whole, fractional = ""] = value.replace(/^-/, "").split(".");
      if (f.scale !== undefined && fractional.length > f.scale)
        fail(f, "too many fractional digits");
      if (
        f.precision !== undefined &&
        (whole === "0" ? 0 : whole.length) > f.precision - (f.scale ?? 0)
      )
        fail(f, "decimal precision exceeded");
      const normalized = value.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
      return /^-?0$/.test(normalized) ? "0" : normalized;
    }
    case "date":
      if (!validDate(value)) fail(f, "invalid calendar date");
      break;
    case "time without time zone":
      if (!validClock(value)) fail(f, "invalid wall-clock time");
      break;
    case "timestamp without time zone": {
      const parts = value.split("T");
      if (parts.length !== 2 || !validDate(parts[0]) || !validClock(parts[1]))
        fail(f, "expected a local date and time without a zone");
      break;
    }
    case "timestamp with time zone": {
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(
          value,
        ) ||
        !validDate(value.slice(0, 10)) ||
        !validClock(value.slice(11).replace(/(Z|[+-]\d{2}:\d{2})$/, "")) ||
        !Number.isFinite(Date.parse(value))
      )
        fail(f, "expected an ISO timestamp with a zone");
      // Preserve sub-millisecond precision; PostgreSQL stores instants at microsecond precision.
      return value;
    }
    case "interval":
      if (
        !/^-?P(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+(\.\d+)?S)?)?$/.test(
          value,
        )
      )
        fail(f, "expected an ISO duration");
      break;
    case "bytea":
      if (
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value,
        )
      )
        fail(f, "expected canonical base64");
      break;
  }
  if (
    f.control === "email" &&
    value &&
    !z.string().email().safeParse(value).success
  )
    fail(f, "invalid email address");
  if (
    f.control === "url" &&
    value &&
    !z.string().url().safeParse(value).success
  )
    fail(f, "invalid URL");
  return value;
}
export function validateRecord(
  schema: RecordSchema,
  input: unknown,
): Record<string, Value> {
  invariant(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "VALIDATION_FAILED",
    "Expected record fields",
  );
  const source = input as Record<string, unknown>;
  const declared = new Set(schema.fields.map((f) => f.id));
  for (const key of Object.keys(source))
    invariant(
      declared.has(key),
      "VALIDATION_FAILED",
      `Undeclared field: ${key}`,
    );
  const output: Record<string, Value> = {};
  for (const f of schema.fields) {
    const value = source[f.id] === undefined ? f.default : source[f.id];
    if (value === undefined) {
      if (f.required || !f.nullable) fail(f, "required field is missing");
      output[f.id] = null;
    } else output[f.id] = decodeField(f, value);
  }
  schema.validate?.(output);
  return output;
}
export const legacyTypes: Record<
  string,
  { pgType: PgType; control?: Field["control"] }
> = {
  uuid: { pgType: "uuid" },
  string: { pgType: "text" },
  markdown: { pgType: "text", control: "textarea" },
  path: { pgType: "text", control: "path" },
  file_search: { pgType: "text" },
  filter_task_sources: { pgType: "jsonb" },
  attribute_reference: { pgType: "uuid", control: "reference" },
  datetime: { pgType: "timestamp with time zone" },
  bool: { pgType: "boolean" },
  int: { pgType: "integer" },
  float: { pgType: "double precision" },
};
export interface Filter {
  id: string;
  field: string;
  operator:
    | "eq"
    | "neq"
    | "contains"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "empty"
    | "not-empty";
  value: Value;
  link: "and" | "or";
  enabled: boolean;
}
export interface Sort {
  field: string;
  direction: "asc" | "desc";
  enabled: boolean;
}
export interface Query {
  filters?: Filter[];
  sorts?: Sort[];
  search?: string;
  groupBy?: string;
  limit?: number;
}
const querySchema = z
  .object({
    filters: z
      .array(
        z
          .object({
            id: z.string().max(200),
            field: z.string(),
            operator: z.enum([
              "eq",
              "neq",
              "gt",
              "gte",
              "lt",
              "lte",
              "contains",
              "empty",
              "not-empty",
            ]),
            link: z.enum(["and", "or"]),
            enabled: z.boolean(),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    sorts: z
      .array(
        z
          .object({
            field: z.string(),
            direction: z.enum(["asc", "desc"]),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .max(30)
      .optional(),
    search: z.string().max(2000).optional(),
    groupBy: z.string().optional(),
    limit: z.number().int().min(1).max(10000).optional(),
  })
  .strict();
export function validateQuery(schema: RecordSchema, input: unknown): Query {
  const parsed = querySchema.safeParse(input);
  invariant(parsed.success, "VALIDATION_FAILED", "Invalid query contract");
  const fields = new Map(schema.fields.map((f) => [f.id, f]));
  for (const clause of [
    ...(parsed.data.filters ?? []),
    ...(parsed.data.sorts ?? []),
  ]) {
    invariant(
      fields.has(clause.field),
      "VALIDATION_FAILED",
      "Unknown query field",
    );
    if (
      "operator" in clause &&
      clause.enabled &&
      !["empty", "not-empty"].includes(clause.operator)
    ) {
      const f = fields.get(clause.field)!;
      if (clause.operator === "contains") {
        invariant(
          f.array || ["text", "character varying", "jsonb"].includes(f.pgType),
          "VALIDATION_FAILED",
          "Contains requires text, JSON or an array",
        );
        decodeField({ ...f, array: false }, clause.value);
      } else decodeField(f, clause.value);
    }
  }
  invariant(
    !parsed.data.groupBy || fields.has(parsed.data.groupBy),
    "VALIDATION_FAILED",
    "Unknown grouping field",
  );
  return parsed.data as Query;
}
function exactDecimal(value: string): [bigint, number] {
  const [whole, part = ""] = value.split(".");
  return [BigInt(whole + part), part.length];
}
export function compareValues(
  f: Field,
  a: Value | undefined,
  b: Value | undefined,
): number {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  if (f.array && Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const difference = compareValues({ ...f, array: false }, a[i], b[i]);
      if (difference) return difference;
    }
    return a.length - b.length;
  }
  if (f.pgType === "bigint" || f.pgType === "numeric") {
    const [x, xs] = exactDecimal(String(a));
    const [y, ys] = exactDecimal(String(b));
    const left = x * 10n ** BigInt(ys);
    const right = y * 10n ** BigInt(xs);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (f.pgType === "timestamp with time zone") {
    const precise = (v: Value) =>
      BigInt(Date.parse(String(v))) * 1000n +
      BigInt(
        (String(v).match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6) ||
          "0",
      );
    const x = precise(a),
      y = precise(b);
    return x < y ? -1 : x > y ? 1 : 0;
  }
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean")
    return Number(a) - Number(b);
  const x = typeof a === "object" ? JSON.stringify(a) : String(a);
  const y = typeof b === "object" ? JSON.stringify(b) : String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
export function queryRecords<
  T extends { id: string; data: Record<string, Value> },
>(records: T[], schema: RecordSchema, query: Query = {}): T[] {
  query = validateQuery(schema, query);
  const fields = new Map(schema.fields.map((f) => [f.id, f]));
  const filters = (query.filters ?? []).filter((f) => f.enabled);
  const result = records.filter((row) => {
    if (
      query.search &&
      !Object.values(row.data).some((v) =>
        String(v ?? "")
          .toLowerCase()
          .includes(query.search!.toLowerCase()),
      )
    )
      return false;
    let matches: boolean | undefined;
    for (const filter of filters) {
      const f = fields.get(filter.field);
      invariant(f, "VALIDATION_FAILED", "Unknown filter field");
      const actual = row.data[f.id];
      const empty =
        actual == null ||
        actual === "" ||
        (Array.isArray(actual) && actual.length === 0);
      const op = filter.operator;
      const expected = ["empty", "not-empty"].includes(op)
        ? filter.value
        : decodeField(
            op === "contains" ? { ...f, array: false } : f,
            filter.value,
          );
      const cmp = ["empty", "not-empty", "contains"].includes(op)
        ? 0
        : compareValues(f, actual, expected);
      const hit =
        op === "empty"
          ? empty
          : op === "not-empty"
            ? !empty
            : op === "contains"
              ? Array.isArray(actual)
                ? actual.some(
                    (value) =>
                      compareValues({ ...f, array: false }, value, expected) ===
                      0,
                  )
                : String(actual ?? "")
                    .toLowerCase()
                    .includes(String(expected).toLowerCase())
              : op === "eq"
                ? cmp === 0
                : op === "neq"
                  ? cmp !== 0
                  : actual == null
                    ? false
                    : op === "gt"
                      ? cmp > 0
                      : op === "gte"
                        ? cmp >= 0
                        : op === "lt"
                          ? cmp < 0
                          : cmp <= 0;
      matches =
        matches === undefined
          ? hit
          : filter.link === "and"
            ? matches && hit
            : matches || hit;
    }
    return matches ?? true;
  });
  result.sort((a, b) => {
    for (const sort of (query.sorts ?? []).filter((s) => s.enabled)) {
      const f = fields.get(sort.field);
      invariant(f, "VALIDATION_FAILED", "Unknown sort field");
      const left = a.data[f.id],
        right = b.data[f.id];
      const diff = compareValues(f, left, right);
      if (diff)
        return left == null || right == null
          ? diff
          : diff * (sort.direction === "asc" ? 1 : -1);
    }
    return a.id.localeCompare(b.id);
  });
  return result.slice(0, Math.min(query.limit ?? 10000, 10000));
}
