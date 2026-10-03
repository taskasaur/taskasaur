import {
  decodeField,
  type Field,
  type Value,
} from "@taskasaur/platform/field-types";
import { invariant } from "@taskasaur/platform/core/errors";

export function encodeSqlField(field: Field, value: Value): unknown {
  if (value == null) return null;
  if (field.array)
    return (value as Value[]).map((v) =>
      encodeSqlField({ ...field, array: false }, v),
    );
  if (field.pgType === "jsonb") return JSON.stringify(value);
  if (field.pgType === "bytea") return Buffer.from(String(value), "base64");
  // PostgreSQL's ISO interval syntax places the sign on each component.
  if (field.pgType === "interval" && String(value).startsWith("-P"))
    return String(value)
      .slice(1)
      .replace(/\d+(?:\.\d+)?[YMDHS]/g, (component) => "-" + component);
  return value;
}
function interval(value: unknown) {
  if (typeof value === "string" && /^-?P/.test(value)) {
    if (!value.startsWith("-P") && value.includes("-")) {
      invariant(
        !/(?<![-\d])\d+(?:\.\d+)?[YMDHS]/.test(value),
        "DATA_INTEGRITY_ERROR",
        "Mixed-sign intervals need an explicit schema migration",
      );
      return "-" + value.replaceAll("-", "");
    }
    return value;
  }
  let parts: Record<string, number> = {};
  if (value && typeof value === "object")
    parts = value as Record<string, number>;
  else {
    const raw = String(value);
    for (const [key, pattern] of [
      ["years", /([+-]?\d+) years?/],
      ["months", /([+-]?\d+) mons?/],
      ["days", /([+-]?\d+) days?/],
    ] as const)
      parts[key] = Number(raw.match(pattern)?.[1] ?? 0);
    const clock = raw.match(/(-?)(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (clock) {
      const sign = clock[1] ? -1 : 1;
      parts.hours = sign * Number(clock[2]);
      parts.minutes = sign * Number(clock[3]);
      parts.seconds = sign * Number(clock[4]);
    }
  }
  const values = [
    parts.years ?? 0,
    parts.months ?? 0,
    parts.days ?? 0,
    parts.hours ?? 0,
    parts.minutes ?? 0,
    (parts.seconds ?? 0) + (parts.milliseconds ?? 0) / 1000,
  ];
  const negative = values.some((v) => v < 0);
  invariant(
    !negative || values.every((v) => v <= 0),
    "DATA_INTEGRITY_ERROR",
    "Mixed-sign intervals are unsupported by the wire contract",
  );
  const [years, months, days, hours, minutes, seconds] = values.map(Math.abs);
  const date =
      (years ? years + "Y" : "") +
      (months ? months + "M" : "") +
      (days ? days + "D" : ""),
    time =
      (hours ? hours + "H" : "") +
      (minutes ? minutes + "M" : "") +
      (seconds ? String(Number(seconds.toFixed(6))) + "S" : "");
  return (
    (negative ? "-" : "") + "P" + date + (time ? "T" + time : date ? "" : "T0S")
  );
}
export function decodeSqlField(field: Field, value: unknown): Value {
  if (value == null) return null;
  if (field.array) {
    invariant(
      Array.isArray(value),
      "DATA_INTEGRITY_ERROR",
      "Expected a SQL array",
    );
    return value.map((v) => decodeSqlField({ ...field, array: false }, v));
  }
  if (value instanceof Date)
    value =
      field.pgType === "date"
        ? value.toISOString().slice(0, 10)
        : value.toISOString();
  if (field.pgType === "bytea" && value instanceof Uint8Array)
    value = Buffer.from(value).toString("base64");
  if (["bigint", "numeric"].includes(field.pgType)) value = String(value);
  if (field.pgType === "timestamp with time zone")
    value = String(value)
      .replace(" ", "T")
      .replace(/([+-]\d{2})$/, "$1:00");
  if (field.pgType === "timestamp without time zone")
    value = String(value).replace(" ", "T");
  if (field.pgType === "interval") value = interval(value);
  return decodeField(field, value);
}
