import {
  field,
  fieldDescriptor,
  type RecordSchema,
  type Value,
} from "../field-types";
import { manifestSchema, type PluginManifest } from "../plugin-sdk";
import { invariant } from "./errors";
import { validateCalendar, validateReminder } from "./calendar-values";
import { withCollectionTables } from "./collection-tables";

export const requiredCoreIds = [
  "access-control",
  "records",
  "data-dexie",
  "peer-sync",
  "settings",
  "variables",
  "tables",
  "files",
  "credentials",
  "devices",
  "jobs",
  "notifications",
] as const;
export const coreServices: Record<string, string[]> = {
  "access-control": ["core.access"],
  records: ["core.records", "core.fields", "core.modules"],
  "data-dexie": ["core.storage.local"],
  "peer-sync": ["core.sync"],
  settings: ["core.settings"],
  variables: ["core.variables"],
  tables: ["core.tables"],
  files: ["files.access"],
  credentials: ["credentials.use"],
  devices: ["core.devices", "core.peers", "core.streams", "core.execution"],
  jobs: ["core.jobs", "core.schedules"],
  notifications: ["core.notifications"],
};
export const isRequiredCore = (id: string) =>
  (requiredCoreIds as readonly string[]).includes(id);
const required = { required: true, nullable: false } as const;
const text = (id = "name", label = "Name") =>
  field(id, label, "text", required);
const timestamp = (id: string, label: string, isRequired = false) =>
  field(id, label, "timestamp with time zone", isRequired ? required : {});
const json = (id: string, label: string, defaultValue: Value = {}) =>
  field(id, label, "jsonb", { default: defaultValue });
const choice = (
  id: string,
  label: string,
  choices: string[],
  initial: string,
) =>
  field(id, label, "text", {
    ...required,
    choices,
    default: initial,
    control: "select",
  });
function schema(
  id: string,
  pluginId: string,
  name: string,
  fields: RecordSchema["fields"],
  validate?: RecordSchema["validate"],
): RecordSchema {
  return { id, pluginId, name, version: 1, fields, validate };
}
export const schemas: RecordSchema[] = [
  schema("settings", "settings", "Settings", [
    text("key", "Key"),
    json("value", "Value"),
    choice("scope", "Scope", ["device", "workspace"], "device"),
  ]),
  schema("variables", "variables", "Variables", [
    text(),
    field("value_type", "Value type", "text", {
      ...required,
      choices: [
        "text",
        "boolean",
        "integer",
        "bigint",
        "numeric",
        "date",
        "timestamp with time zone",
        "jsonb",
      ],
      default: "text",
      control: "select",
    }),
    json("value", "Value", ""),
    field("namespace", "Namespace"),
    field("description", "Description", "text", { control: "textarea" }),
  ]),
  schema("tables", "tables", "Tables", [
    text(),
    json("columns", "Columns", []),
    field("collection_id", "Collection"),
    field("is_default", "Default table", "boolean", { default: false }),
    field("description", "Description", "text", { control: "textarea" }),
  ]),
  schema("table_rows", "tables", "Table rows", [
    field("table_id", "Table", "uuid", required),
    json("values", "Values"),
  ]),
  schema("files", "files", "Files", [
    text(),
    text("media_type", "Media type"),
    field("size", "Size", "bigint", { ...required, default: "0" }),
    field("version_id", "Version", "uuid"),
    field("parent_id", "Folder", "uuid"),
    field("is_folder", "Folder", "boolean", { default: false }),
    field("checksum", "Checksum"),
    choice(
      "upload_state",
      "Status",
      ["local", "uploading", "available", "error"],
      "local",
    ),
  ]),
  schema("credentials", "credentials", "Credentials", [
    text(),
    text("provider", "Provider"),
    choice(
      "auth_kind",
      "Authentication",
      ["password", "api-key", "oauth2", "ssh-key"],
      "password",
    ),
    json("allowed_plugins", "Allowed plugins", []),
    json("allowed_destinations", "Allowed destinations", []),
    choice(
      "status",
      "Status",
      ["ready", "revoked", "expired", "needs-authorization"],
      "ready",
    ),
  ]),
  schema("devices", "devices", "Devices", [
    text(),
    choice(
      "platform",
      "Platform",
      ["browser", "desktop", "ios", "android", "server", "runner"],
      "browser",
    ),
    json("capabilities", "Capabilities", []),
    timestamp("last_seen", "Last seen"),
    field("lease_epoch", "Lease epoch", "integer", { default: 0 }),
    field("revoked", "Revoked", "boolean", { default: false }),
  ]),
  schema("jobs", "jobs", "Jobs", [
    text("kind", "Kind"),
    json("payload", "Payload"),
    choice(
      "status",
      "Status",
      ["queued", "running", "waiting", "completed", "failed", "cancelled"],
      "queued",
    ),
    timestamp("run_at", "Run at"),
    field("target_device_id", "Run on", "uuid"),
    field("attempt", "Attempt", "integer", { default: 0, min: 0 }),
    field("error", "Error", "text", { control: "textarea" }),
  ]),
  schema("notifications", "notifications", "Notifications", [
    text("title", "Title"),
    field("body", "Message", "text", { control: "textarea" }),
    timestamp("read_at", "Read at"),
    field("resource_id", "Resource", "uuid"),
    field("dedupe_key", "Delivery key"),
    field("sound", "Play sound", "boolean", { default: false }),
  ]),
];
const references: Record<string, Record<string, string>> = {
  table_rows: { table_id: "tables" },
  files: { parent_id: "files" },
  jobs: { target_device_id: "devices" },
  notifications: { resource_id: "resources" },
};
for (const definition of schemas)
  for (const [id, target] of Object.entries(references[definition.id] ?? {})) {
    const field = definition.fields.find((f) => f.id === id);
    if (field) {
      field.reference = target;
      field.control = "reference";
    }
  }
export const catalog: PluginManifest[] = requiredCoreIds.map((id) =>
  manifestSchema.parse({
    id,
    name: id
      .split("-")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join(" "),
    description: `Required shared ${id} provider.`,
    version: "1.0.0",
    platformApi: "^1.0.0",
    fieldSchemaApi: "^1.0.0",
    publisher: "taskasaur",
    license: "GPL-3.0-only",
    entrypoints: {},
    ui: { mode: "shared", apiVersion: "^1.0.0", surfaces: [id] },
    storage: {
      local: {
        mode: "dexie",
        collections: schemas.filter((s) => s.pluginId === id).map((s) => s.id),
      },
    },
    permissions: [`${id}.read`, `${id}.write`],
    dependencies: [],
    features: {},
    sharedServices: [{ id: "core.records", version: "^1", optional: false }],
    provides: {
      commands: schemas
        .filter((s) => s.pluginId === id)
        .flatMap((s) => [`${s.id}.list`, `${s.id}.put`, `${s.id}.delete`]),
      events: schemas
        .filter((s) => s.pluginId === id)
        .map((s) => `${s.id}.changed`),
    },
    consumes: { commands: [], events: [] },
  }),
);
// Existing collection identifiers are reserved to preserve data through extraction.
const legacyOwners: Record<string, string> = {
  tasks: "tasks",
  track: "track",
  time: "time",
  presets: "track",
  calendar: "calendar",
  reminders: "reminders",
  mail_accounts: "email-client",
  mail: "email-client",
  mailboxes: "email-client",
  mail_operations: "email-client",
  github_connections: "connector-github",
  github_issues: "connector-github",
  workflows: "automation-runtime",
  workflow_runs: "automation-runtime",
  office: "office-editor",
  grants: "sharing",
};
export const schemaById = new Map(schemas.map((s) => [s.id, s]));
export const manifestById = new Map(catalog.map((p) => [p.id, p]));
export function getSchema(id: string) {
  const s = schemaById.get(id);
  invariant(s, "VALIDATION_FAILED", `Unknown collection: ${id}`);
  return s;
}
export function validateExtension(input: unknown, contracts: unknown) {
  const manifest = manifestSchema.parse(input);
  invariant(
    !isRequiredCore(manifest.id),
    "RESERVED_PROVIDER",
    "Platform providers are updated by a platform release",
  );
  invariant(
    Array.isArray(contracts),
    "VALIDATION_FAILED",
    "Expected collection contracts",
  );
  const prefix = manifest.id.replaceAll(/[.-]/g, "_") + "_";
  invariant(
    !manifest.ui.mainPage ||
      manifest.ui.surfaces.includes(manifest.ui.mainPage) ||
      manifest.ui.pages?.some((p) => p.id === manifest.ui.mainPage),
    "UNDECLARED_SURFACE",
    "The main page must be declared",
  );
  invariant(
    new Set(manifest.ui.pages?.map((p) => p.id)).size ===
      (manifest.ui.pages?.length ?? 0),
    "CONTRACT_COLLISION",
    "Page IDs must be unique",
  );
  for (const page of manifest.ui.pages ?? [])
    invariant(
      !page.collection ||
        manifest.storage.local.collections.includes(page.collection),
      "UNDECLARED_COLLECTION",
      "Page collections must belong to the plugin",
    );
  const parsed: RecordSchema[] = contracts.map((contract) => {
    invariant(
      contract && typeof contract === "object",
      "VALIDATION_FAILED",
      "Invalid collection contract",
    );
    const schema = contract as RecordSchema;
    invariant(
      schema.pluginId === manifest.id &&
        (schema.id.startsWith(prefix) ||
          (manifest.publisher === "taskasaur" &&
            legacyOwners[schema.id] === manifest.id)) &&
        /^[a-z][a-z0-9_]{0,49}$/.test(schema.id),
      "RESERVED_PROVIDER",
      "Collection IDs must use the plugin namespace",
    );
    invariant(
      Number.isInteger(schema.version) &&
        schema.version >= 1 &&
        Array.isArray(schema.fields) &&
        schema.fields.length > 0 &&
        schema.fields.length <= 128,
      "VALIDATION_FAILED",
      "Invalid collection version or fields",
    );
    const fields = schema.fields.map((f) => fieldDescriptor.parse(f));
    invariant(
      new Set(fields.map((f) => f.id)).size === fields.length,
      "VALIDATION_FAILED",
      "Duplicate field IDs",
    );
    invariant(
      manifest.storage.local.collections.includes(schema.id),
      "UNDECLARED_COLLECTION",
      "Collection was not declared",
    );
    invariant(
      !schema.standard ||
        ["ical-event", "ical-alarm", "time-interval"].includes(schema.standard),
      "VALIDATION_FAILED",
      "Unknown schema standard",
    );
    return withCollectionTables({
      standard: schema.standard,
      validate:
        schema.standard === "ical-event"
          ? validateCalendar
          : schema.standard === "ical-alarm"
            ? validateReminder
            : schema.standard === "time-interval"
              ? (data: Record<string, Value>) =>
                  invariant(
                    !data.ended_at ||
                      Date.parse(String(data.ended_at)) >=
                        Date.parse(String(data.started_at)),
                    "VALIDATION_FAILED",
                    "End must follow start",
                  )
              : undefined,
      id: schema.id,
      pluginId: manifest.id,
      name: String(schema.name),
      version: schema.version,
      fields,
      tables: schema.tables,
    });
  });
  const executionOperations = new Set<string>();
  for (const slot of manifest.execution ?? []) {
    const schema = parsed.find((s) => s.id === slot.collection);
    invariant(
      schema,
      "UNDECLARED_COLLECTION",
      "Execution slots must belong to a plugin collection",
    );
    for (const [id, type] of [
      [slot.targetField, "uuid"],
      [slot.enabledField, "boolean"],
    ])
      invariant(
        !id ||
          schema.fields.some(
            (f) => f.id === id && f.pgType === type && !f.array,
          ),
        "INVALID_EXECUTION",
        "Execution fields must use UUID/boolean descriptors",
      );
    for (const command of [
      ...slot.commands,
      ...(slot.background ? [slot.background.command] : []),
    ])
      invariant(
        manifest.provides.commands.includes(command),
        "UNDECLARED_COMMAND",
        "Declare execution commands in provides.commands",
      );
    for (const operation of new Set([
      ...slot.commands,
      ...slot.routes,
      ...(slot.background ? [slot.background.command] : []),
    ])) {
      for (const collection of new Set([
        slot.collection,
        ...slot.references.map((ref) => ref.collection),
      ])) {
        const key = collection + ":" + operation;
        invariant(
          !executionOperations.has(key),
          "INVALID_EXECUTION",
          "An operation must resolve to one execution slot per collection",
        );
        executionOperations.add(key);
      }
    }
    for (const route of slot.routes)
      invariant(
        !route.includes("*") &&
          manifest.server?.routes.some(
            (r) =>
              r.path === route ||
              (r.path.endsWith("*") && route.startsWith(r.path.slice(0, -1))),
          ),
        "UNDECLARED_ROUTE",
        "Declare execution routes in server.routes",
      );
    for (const reference of slot.references)
      invariant(
        parsed.some(
          (s) =>
            s.id === reference.collection &&
            s.fields.some(
              (f) =>
                f.id === reference.field && f.pgType === "uuid" && !f.array,
            ),
        ),
        "INVALID_EXECUTION",
        "Execution references must use an owned UUID field",
      );
  }
  invariant(
    new Set((manifest.execution ?? []).map((s) => s.id)).size ===
      (manifest.execution ?? []).length,
    "INVALID_EXECUTION",
    "Execution slot IDs must be unique",
  );
  for (const command of manifest.provides.commands)
    invariant(
      command.startsWith(manifest.id + ".") ||
        (manifest.publisher === "taskasaur" &&
          manifest.id === "email-client" &&
          [
            "mail.sync",
            "mail.read",
            "mail.send",
            "mail.applyOperation",
            "mail.folders",
          ].includes(command)) ||
        parsed.some((s) =>
          [`${s.id}.list`, `${s.id}.put`, `${s.id}.delete`].includes(command),
        ),
      "RESERVED_PROVIDER",
      "Commands must use the plugin namespace",
    );
  for (const route of manifest.server?.routes ?? []) {
    const legacy: Record<string, string> = {
      "email-client": "mail/",
      "connector-github": "github/",
      "automation-runtime": "automation/",
      "remote-terminal": "terminal/",
    };
    invariant(
      route.path.startsWith(`extensions/${manifest.id}/`) ||
        (manifest.publisher === "taskasaur" &&
          legacy[manifest.id] &&
          route.path.startsWith(legacy[manifest.id])),
      "RESERVED_PROVIDER",
      "HTTP routes must use extensions/<plugin-id>/",
    );
  }
  for (const schema of parsed) {
    const old = schemaById.get(schema.id);
    invariant(
      !old || old.pluginId === manifest.id,
      "CONTRACT_COLLISION",
      "Collection is already owned",
    );
  }
  return { manifest, schemas: parsed };
}
export function registerExtension(input: unknown, contracts: unknown) {
  const { manifest, schemas: parsed } = validateExtension(input, contracts);
  for (const schema of parsed) {
    schemaById.set(schema.id, schema);
    const at = schemas.findIndex((s) => s.id === schema.id);
    if (at >= 0) schemas[at] = schema;
    else schemas.push(schema);
  }
  manifestById.set(manifest.id, manifest);
  const at = catalog.findIndex((p) => p.id === manifest.id);
  if (at >= 0) catalog[at] = manifest;
  else catalog.push(manifest);
  return { manifest, schemas: parsed };
}
