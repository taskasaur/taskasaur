import {
  field,
  validateRecord,
  type Field,
  type RecordSchema,
  type Value,
} from "../field-types";
import { tableFields } from "./dynamic-fields";
import { invariant } from "./errors";

export const legacyTableCollections = [
  "tasks",
  "calendar",
  "reminders",
  "time",
  "track",
  "mail",
];
export const tableSystemFields = new Set(["table_id", "custom_fields"]);
const standards: Record<
  string,
  { name: string; url?: string; required: string[] }
> = {
  tasks: {
    name: "iCalendar VTODO",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.2",
    required: ["uid", "dtstamp"],
  },
  calendar: {
    name: "iCalendar VEVENT (without METHOD)",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1",
    required: ["uid", "dtstamp", "dtstart"],
  },
  reminders: {
    name: "iCalendar VALARM",
    url: "https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6",
    required: ["action", "trigger"],
  },
  time: { name: "Time interval runtime", required: ["started_at"] },
  track: { name: "General tracking record", required: [] },
  mail: {
    name: "RFC 5322 (drafts may be incomplete)",
    url: "https://www.rfc-editor.org/rfc/rfc5322#section-3.6",
    required: [],
  },
};
export function tableStandard(schema: RecordSchema) {
  return (
    standards[schema.id] ?? {
      name: "Plugin contract",
      required: schema.fields.filter((f) => f.required).map((f) => f.id),
    }
  );
}
/** Upgrade the bundled v1 contracts without changing signed plugin artifacts. */
export function withCollectionTables(schema: RecordSchema): RecordSchema {
  if (!schema.tables && !legacyTableCollections.includes(schema.id))
    return schema;
  const standard = standards[schema.id];
  const fields = schema.fields
    .filter((f) => !tableSystemFields.has(f.id))
    .map((f) =>
      standard
        ? {
            ...f,
            required: standard.required.includes(f.id),
            nullable: !standard.required.includes(f.id),
          }
        : f,
    );
  if (["tasks", "calendar"].includes(schema.id)) {
    for (const [id, label, pgType, generated] of [
      ["uid", "UID", "text", "uuid"],
      ["dtstamp", "DTSTAMP", "timestamp with time zone", "timestamp"],
    ] as const) {
      const existing = fields.find((f) => f.id === id);
      if (existing) existing.generated = generated;
      else
        fields.push(
          field(id, label, pgType, {
            required: true,
            nullable: false,
            generated,
          }),
        );
    }
    const sharedPresets = [
      field("classification", "Classification", "text", {
        choices: ["PUBLIC", "PRIVATE", "CONFIDENTIAL"],
      }),
      field("created", "Created", "timestamp with time zone"),
      field("last_modified", "Last modified", "timestamp with time zone"),
      field("location", "Location"),
      field("organizer", "Organizer", "text", { control: "email" }),
      field("geo", "Geographic position", "jsonb"),
      field("sequence", "Sequence", "integer", { min: 0 }),
      field("url", "URL", "text", { control: "url" }),
      field("rrule", "Recurrence rule"),
      field("recurrence_id", "Recurrence ID"),
      field("attachments", "Attachments", "text", { array: true }),
      field("attendees", "Attendees", "text", { array: true }),
      field("categories", "Categories", "text", { array: true }),
      field("comments", "Comments", "text", { array: true }),
      field("contacts", "Contacts", "text", { array: true }),
      field("related_to", "Related items", "text", { array: true }),
      field("resources", "Resources", "text", { array: true }),
      field("exdates", "Excluded recurrence dates", "jsonb"),
      field("rdates", "Additional recurrence dates", "jsonb"),
      field("request_status", "Request status", "text", { array: true }),
      ...(schema.id === "tasks"
        ? [
            field("dtstart", "Start"),
            field("duration", "Duration", "interval"),
            field("completed", "Completed", "timestamp with time zone"),
            field("percent_complete", "Percent complete", "integer", {
              min: 0,
              max: 100,
            }),
          ]
        : [field("priority", "Priority", "integer", { min: 0, max: 9 })]),
    ];
    for (const preset of sharedPresets)
      if (!fields.some((f) => f.id === preset.id)) fields.push(preset);
  }
  if (schema.id === "reminders" && !fields.some((f) => f.id === "attachments"))
    fields.push(field("attachments", "Attachments", "text", { array: true }));
  if (schema.id === "mail")
    for (const preset of [
      field("sent_at", "Date", "timestamp with time zone"),
      field("sender", "Sender", "text", { control: "email" }),
      field("reply_to", "Reply-To", "text", { array: true }),
      field("comments", "Comments"),
      field("keywords", "Keywords", "text", { array: true }),
    ])
      if (!fields.some((f) => f.id === preset.id)) fields.push(preset);
  return {
    ...schema,
    tables: true,
    fields: [
      ...fields,
      field("table_id", "Table", "uuid"),
      field("custom_fields", "Custom fields", "jsonb", { default: {} }),
    ],
  };
}
export function collectionColumns(
  schema: RecordSchema,
  value?: unknown,
): Field[] {
  const fields = schema.fields.filter((f) => !tableSystemFields.has(f.id));
  if (value === undefined) return fields;
  const columns = tableFields(value);
  const required = tableStandard(schema).required;
  for (const id of required)
    invariant(
      columns.some((f) => f.id === id),
      "REQUIRED_COLUMN",
      `The standard requires ${id}`,
    );
  for (const column of columns) {
    invariant(
      !tableSystemFields.has(column.id),
      "RESERVED_COLUMN",
      "This column is reserved by core",
    );
    const base = fields.find((f) => f.id === column.id);
    if (base)
      invariant(
        (Object.keys(base) as Array<keyof Field>)
          .filter((key) => !["label", "description"].includes(key))
          .every(
            (key) => JSON.stringify(column[key]) === JSON.stringify(base[key]),
          ),
        "STANDARD_COLUMN",
        "Standard column types and requirements cannot be changed",
      );
  }
  return columns;
}
export function customValues(
  schema: RecordSchema,
  columns: unknown,
  values: unknown,
) {
  const fields = collectionColumns(schema, columns).filter(
    (f) => !schema.fields.some((base) => base.id === f.id),
  );
  return validateRecord(
    { ...schema, fields, validate: undefined },
    values ?? {},
  );
}
export function generatedValues(
  schema: RecordSchema,
  input: unknown,
  previous?: Record<string, Value>,
) {
  invariant(
    input !== null && typeof input === "object" && !Array.isArray(input),
    "VALIDATION_FAILED",
    "Expected record fields",
  );
  const data = { ...(input as Record<string, Value>) };
  for (const f of schema.fields)
    if (f.generated && data[f.id] == null)
      data[f.id] =
        previous?.[f.id] ??
        (f.generated === "uuid"
          ? crypto.randomUUID()
          : new Date().toISOString());
  return data;
}
