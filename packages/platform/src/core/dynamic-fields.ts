import {
  fieldDescriptor,
  validateRecord,
  decodeField,
  field,
  type Field,
  type Value,
  type PgType,
} from "../field-types";
import { invariant } from "./errors";
export function tableFields(value: unknown): Field[] {
  invariant(
    Array.isArray(value) && value.length > 0 && value.length <= 128,
    "VALIDATION_FAILED",
    "A table requires between 1 and 128 columns",
  );
  const fields = value.map((v) => fieldDescriptor.parse(v));
  invariant(
    new Set(fields.map((f) => f.id)).size === fields.length,
    "VALIDATION_FAILED",
    "Column IDs must be unique",
  );
  invariant(
    fields.every((f) => !f.sensitive),
    "VALIDATION_FAILED",
    "Store secrets through Credentials, not user tables",
  );
  return fields;
}
export function validateTableValues(columns: unknown, values: unknown) {
  return validateRecord(
    {
      id: "values",
      name: "Values",
      pluginId: "tables",
      version: 1,
      fields: tableFields(columns),
    },
    values,
  );
}
export function validateDynamicData(
  collection: string,
  data: Record<string, Value>,
) {
  if (collection === "tables") tableFields(data.columns);
  if (collection === "variables")
    data.value = decodeField(
      field("value", "Value", data.value_type as PgType),
      data.value,
    );
}
