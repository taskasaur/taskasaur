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
    Array.isArray(value) && value.length <= 128,
    "VALIDATION_FAILED",
    "A table requires between 0 and 128 columns",
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
  for (const f of fields) {
    invariant(
      !f.inputMode || f.array === ["list", "multiselect"].includes(f.inputMode),
      "VALIDATION_FAILED",
      "Input count must match the field list type",
    );
    invariant(
      f.minItems === undefined ||
        f.maxItems === undefined ||
        f.minItems <= f.maxItems,
      "VALIDATION_FAILED",
      "Minimum inputs cannot exceed maximum inputs",
    );
    invariant(
      f.array || (f.minItems === undefined && f.maxItems === undefined),
      "VALIDATION_FAILED",
      "Input limits require a list",
    );
    invariant(
      !["select", "multiselect"].includes(f.inputMode ?? "") ||
        Boolean(f.options?.length),
      "VALIDATION_FAILED",
      "Selection fields require options",
    );
    invariant(
      !f.options ||
        new Set(f.options.map((option) => JSON.stringify(option))).size ===
          f.options.length,
      "VALIDATION_FAILED",
      "Selection options must be unique",
    );
    invariant(
      !f.required ||
        !["hidden", "viewable"].includes(f.visibility ?? "") ||
        f.default !== undefined ||
        Boolean(f.generated),
      "VALIDATION_FAILED",
      "Required fields that cannot be edited need a default value",
    );
    if (f.default !== undefined) decodeField(f, f.default);
    if (f.options)
      for (const option of f.options)
        decodeField(
          { ...f, array: false, inputMode: "single", nullable: false },
          option,
        );
  }
  return fields;
}
export function validateTableValues(columns: unknown, values: unknown) {
  const fields = tableFields(columns),
    stored = decodeField(field("values", "Values", "jsonb"), values);
  invariant(
    stored && typeof stored === "object" && !Array.isArray(stored),
    "VALIDATION_FAILED",
    "Table values must be an object",
  );
  return {
    ...stored,
    ...validateRecord(
      {
        id: "values",
        name: "Values",
        pluginId: "tables",
        version: 1,
        fields,
      },
      Object.fromEntries(
        Object.entries(stored).filter(([key]) =>
          fields.some((f) => f.id === key),
        ),
      ),
    ),
  };
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
