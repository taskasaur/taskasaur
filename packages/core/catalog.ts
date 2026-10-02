import {
  field,
  fieldDescriptor,
  type RecordSchema,
  type Value,
} from "../field-types";
import { manifestSchema, type PluginManifest } from "../plugin-sdk";
import { invariant } from "./errors";
import { validateCalendar, validateReminder } from "./calendar-values";

export const requiredCoreIds = [
  "access-control",
  "records",
  "data-dexie",
  "sync-supabase",
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
  records: ["core.records", "core.fields"],
  "data-dexie": ["core.storage.local"],
  "sync-supabase": ["core.sync"],
  settings: ["core.settings"],
  variables: ["core.variables"],
  tables: ["core.tables"],
  files: ["files.access"],
  credentials: ["credentials.use"],
  devices: ["core.devices", "core.streams"],
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
  schema("tasks", "tasks", "Tasks", [
    text("title", "Title"),
    choice(
      "status",
      "Status",
      ["open", "in-progress", "done", "cancelled"],
      "open",
    ),
    field("description", "Description", "text", { control: "textarea" }),
    field("due_date", "Due date", "date"),
    timestamp("due_at", "Due at"),
    field("priority", "Priority", "integer", { default: 0, min: 0, max: 4 }),
    field("parent_id", "Parent task", "uuid"),
    field("tags", "Tags", "text", { array: true, default: [] }),
    json("dependencies", "Dependencies", []),
  ]),
  schema("track", "track", "Track", [
    text("title", "Activity"),
    timestamp("started_at", "Started", true),
    timestamp("ended_at", "Ended"),
    field("notes", "Notes", "text", { control: "textarea" }),
    field("measurement", "Measurement", "numeric", { precision: 18, scale: 6 }),
    field("unit", "Unit"),
    field("task_id", "Task", "uuid"),
    json("metadata", "Custom fields"),
  ]),
  schema(
    "time",
    "time",
    "Time",
    [
      text("title", "Activity"),
      timestamp("started_at", "Started", true),
      timestamp("ended_at", "Ended"),
      choice("kind", "Kind", ["work", "break", "focus"], "work"),
      field("task_id", "Task", "uuid"),
      field("notes", "Notes", "text", { control: "textarea" }),
      field("paused_ms", "Paused milliseconds", "bigint", { default: "0" }),
      timestamp("paused_at", "Paused at"),
      field("target_seconds", "Timer duration (seconds)", "integer", {
        min: 1,
        max: 86400,
      }),
    ],
    (data) => {
      invariant(
        !data.ended_at ||
          Date.parse(String(data.ended_at)) >=
            Date.parse(String(data.started_at)),
        "VALIDATION_FAILED",
        "End must follow start",
      );
    },
  ),
  schema("presets", "track", "Presets", [
    text(),
    json("values", "Preset values"),
  ]),
  schema(
    "calendar",
    "calendar",
    "Calendar",
    [
      text("uid", "UID"),
      timestamp("dtstamp", "DTSTAMP", true),
      field("dtstart", "DTSTART", "text", required),
      field("summary", "Title"),
      field("description", "Description", "text", { control: "textarea" }),
      field("dtend", "End"),
      field("duration", "Duration", "interval"),
      field("timezone", "Time zone"),
      field("location", "Location"),
      field("rrule", "Recurrence rule"),
      json("exdates", "Exceptions", []),
      json("rdates", "Additional dates", []),
      field("recurrence_id", "Recurrence instance"),
      json("attendees", "Attendees", []),
      json("alarms", "Embedded iCalendar alarms", []),
      field("organizer", "Organizer"),
      field("url", "URL", "text", { control: "url" }),
      field("sequence", "Sequence", "integer", { default: 0, min: 0 }),
      choice("transp", "Availability", ["OPAQUE", "TRANSPARENT"], "OPAQUE"),
      choice(
        "status",
        "Status",
        ["CONFIRMED", "TENTATIVE", "CANCELLED"],
        "CONFIRMED",
      ),
    ],
    validateCalendar,
  ),
  schema(
    "reminders",
    "reminders",
    "Reminders",
    [
      choice("action", "ACTION", ["DISPLAY", "EMAIL", "AUDIO"], "DISPLAY"),
      text("trigger", "TRIGGER"),
      field("description", "DESCRIPTION", "text", { control: "textarea" }),
      field("summary", "SUMMARY"),
      field("attendees", "ATTENDEE", "text", { array: true, default: [] }),
      field("parent_id", "Parent event/task", "uuid"),
      choice("related", "Trigger relative to", ["START", "END"], "START"),
      field("mail_account_id", "Sending mail account", "uuid", {
        reference: "mail_accounts",
        control: "reference",
      }),
      field("repeat", "REPEAT", "integer", { min: 0, max: 1000 }),
      field("duration", "DURATION", "interval"),
      field("enabled", "Enabled", "boolean", { default: true }),
      timestamp("acknowledged_at", "Acknowledged"),
      timestamp("snoozed_until", "Snoozed until"),
    ],
    validateReminder,
  ),
  schema("mail_accounts", "email-client", "Mail accounts", [
    text(),
    field("address", "Email", "text", { ...required, control: "email" }),
    field("credential_id", "Credential", "uuid", required),
    text("imap_host", "IMAP host"),
    field("imap_port", "IMAP port", "integer", {
      default: 993,
      min: 1,
      max: 65535,
    }),
    text("smtp_host", "SMTP host"),
    field("smtp_port", "SMTP port", "integer", {
      default: 465,
      min: 1,
      max: 65535,
    }),
    choice("smtp_security", "SMTP security", ["tls", "starttls"], "tls"),
  ]),
  schema("mail", "email-client", "Mail", [
    field("account_id", "Account", "uuid"),
    field("mailbox", "Mailbox", "text", { default: "INBOX" }),
    field("subject", "Subject"),
    field("from", "From"),
    field("to", "To", "text", { array: true, default: [] }),
    field("cc", "Cc", "text", { array: true, default: [] }),
    field("bcc", "Bcc", "text", { array: true, default: [] }),
    field("body", "Message", "text", { control: "textarea" }),
    field("html", "HTML", "text"),
    field("message_id", "Message ID"),
    field("provider_uid", "Provider UID"),
    field("uid_validity", "UID validity"),
    timestamp("received_at", "Received"),
    choice(
      "status",
      "Status",
      ["draft", "queued", "sending", "sent", "received", "failed", "unknown"],
      "draft",
    ),
    field("read", "Read", "boolean", { default: false }),
    field("flags", "Flags", "text", { array: true, default: [] }),
    field("in_reply_to", "Reply to Message-ID"),
    field("references", "Thread references", "text", {
      array: true,
      default: [],
    }),
    field("send_operation_id", "Send operation", "uuid"),
    field("provider_deleted", "Removed from mailbox", "boolean", {
      default: false,
    }),
    json("attachments", "Attachments", []),
  ]),
  schema("mailboxes", "email-client", "Mailboxes", [
    field("account_id", "Account", "uuid", {
      ...required,
      reference: "mail_accounts",
      control: "reference",
    }),
    text(),
    text("path", "Path"),
    field("special_use", "Special use"),
  ]),
  schema("mail_operations", "email-client", "Mailbox operations", [
    field("message_id", "Message", "uuid", {
      ...required,
      reference: "mail",
      control: "reference",
    }),
    choice(
      "operation",
      "Operation",
      ["read", "unread", "flag", "unflag", "move"],
      "read",
    ),
    field("mailbox", "Destination mailbox"),
    choice("status", "Status", ["queued", "completed", "failed"], "queued"),
    field("error", "Error"),
  ]),
  schema("github_connections", "connector-github", "GitHub repositories", [
    text(),
    field("credential_id", "Credential", "uuid", {
      ...required,
      reference: "credentials",
      control: "reference",
    }),
    text("owner", "Repository owner"),
    text("repository", "Repository"),
  ]),
  schema("github_issues", "connector-github", "GitHub issues", [
    field("connection_id", "Repository", "uuid", {
      ...required,
      reference: "github_connections",
      control: "reference",
    }),
    field("number", "Issue number", "integer", required),
    text("title", "Title"),
    field("body", "Description", "text", { control: "textarea" }),
    choice("state", "State", ["open", "closed"], "open"),
    field("url", "URL", "text", { control: "url" }),
    field("labels", "Labels", "text", { array: true, default: [] }),
    timestamp("provider_updated_at", "Updated"),
    field("task_id", "Linked task", "uuid", {
      reference: "tasks",
      control: "reference",
    }),
  ]),
  schema("workflows", "automation-runtime", "Workflows", [
    text(),
    json("graph", "Graph", { nodes: [], edges: [] }),
    field("target_device_id", "Run on", "uuid"),
    field("enabled", "Enabled", "boolean", { default: false }),
    field("published_version", "Published version", "integer"),
    choice(
      "trigger_kind",
      "Trigger",
      ["manual", "schedule", "event", "webhook"],
      "manual",
    ),
    field("schedule_seconds", "Schedule interval in seconds", "integer", {
      min: 10,
      max: 31536000,
    }),
    timestamp("schedule_start", "Schedule starts"),
    choice("catch_up", "Missed schedule", ["skip", "once", "all"], "once"),
    field("event_type", "Committed event type", "text"),
    field("allow_trusted_code", "Allow trusted TypeScript code", "boolean", {
      default: false,
      description:
        "Code runs with this device's OS account. Enable only for code you trust.",
    }),
    choice(
      "offline_policy",
      "Offline policy",
      ["fail", "waitForDevice"],
      "fail",
    ),
    field("dispatch_timeout_seconds", "Wait timeout", "integer", {
      min: 1,
      max: 86400,
    }),
    field("description", "Description", "text", { control: "textarea" }),
  ]),
  schema("workflow_runs", "automation-runtime", "Workflow runs", [
    field("workflow_id", "Workflow", "uuid", required),
    field("target_device_id", "Run on", "uuid", required),
    field("workflow_version", "Workflow version", "integer", required),
    choice(
      "status",
      "Status",
      [
        "queued",
        "running",
        "waiting",
        "completed",
        "failed",
        "cancelled",
        "expired",
      ],
      "queued",
    ),
    json("input", "Input"),
    json("output", "Output"),
    json("steps", "Steps", []),
    timestamp("started_at", "Started"),
    timestamp("ended_at", "Ended"),
    field("error", "Error", "text", { control: "textarea" }),
  ]),
  schema("office", "office-editor", "Office", [
    text(),
    choice(
      "kind",
      "Kind",
      ["document", "spreadsheet", "presentation"],
      "document",
    ),
    field("file_id", "File", "uuid", required),
  ]),
  schema("grants", "sharing", "Sharing", [
    field("resource_id", "Resource", "uuid", required),
    field("subject_id", "Person", "uuid", required),
    choice("role", "Role", ["viewer", "commenter", "editor"], "viewer"),
    timestamp("expires_at", "Expires"),
  ]),
];
const references: Record<string, Record<string, string>> = {
  table_rows: { table_id: "tables" },
  files: { parent_id: "files" },
  tasks: { parent_id: "tasks" },
  track: { task_id: "tasks" },
  time: { task_id: "tasks" },
  reminders: { parent_id: "resources" },
  mail_accounts: { credential_id: "credentials" },
  mail: { account_id: "mail_accounts" },
  workflows: { target_device_id: "devices" },
  workflow_runs: { workflow_id: "workflows", target_device_id: "devices" },
  office: { file_id: "files" },
  jobs: { target_device_id: "devices" },
  notifications: { resource_id: "resources" },
  grants: { resource_id: "resources", subject_id: "people" },
};
for (const definition of schemas)
  for (const [id, target] of Object.entries(references[definition.id] ?? {})) {
    const value = definition.fields.find((f) => f.id === id);
    if (value) {
      value.reference = target;
      value.control = "reference";
    }
  }
const featureDescriptions: Record<string, string> = {
  tasks: "Tasks, subtasks, dependencies, and boards.",
  track: "Activity history, measurements, and presets.",
  time: "Timers, intervals, focus, and breaks.",
  calendar: "Events, recurrence, and standards-based calendar import/export.",
  reminders: "Scheduled reminders with required iCalendar fields.",
  "email-client":
    "Mail accounts, mailbox sync, drafts, attachments, and send/receive.",
  "automation-runtime":
    "TypeScript workflows executed on an explicitly selected device.",
  "automation-editor": "Visual workflow editor and execution history.",
  "remote-terminal": "Authorized interactive shells on connected computers.",
  "office-editor": "Offline documents, spreadsheets, and presentations.",
  sharing: "Scoped resource sharing and permissions.",
  "connector-github": "GitHub issues and actions through shared credentials.",
};
export const featureIds = Object.keys(featureDescriptions);
const featureServices: Record<string, string[]> = {
  "email-client": ["credentials.use", "files.access", "core.jobs"],
  reminders: ["core.jobs", "core.schedules", "core.notifications"],
  "remote-terminal": ["core.devices", "core.streams", "credentials.use"],
  "office-editor": ["files.access"],
  "automation-runtime": ["core.jobs", "core.devices", "credentials.use"],
  "automation-editor": ["core.devices"],
  sharing: ["core.access"],
  "connector-github": ["credentials.use"],
};
export const catalog: PluginManifest[] = [
  ...requiredCoreIds,
  ...featureIds,
].map((id) =>
  manifestSchema.parse({
    id,
    name: id
      .split("-")
      .map((s) => s[0].toUpperCase() + s.slice(1))
      .join(" "),
    description: featureDescriptions[id] ?? `Required shared ${id} provider.`,
    version: "1.0.0",
    platformApi: "^1.0.0",
    fieldSchemaApi: "^1.0.0",
    publisher: "taskasaur",
    license: "GPL-3.0-only",
    // Built-in adapters are linked by the platform release, with lazy client views.
    entrypoints: {},
    ui: { mode: "shared", apiVersion: "^1.0.0", surfaces: [id] },
    storage: {
      local: {
        mode: "dexie",
        collections: schemas.filter((s) => s.pluginId === id).map((s) => s.id),
      },
    },
    permissions: [`${id}.read`, `${id}.write`],
    dependencies: id === "automation-editor" ? ["automation-runtime"] : [],
    features: Object.fromEntries(
      (id === "email-client"
        ? ["attachments", "notifications", "taskLinks"]
        : id === "connector-github"
          ? ["taskLinks"]
          : []
      ).map((name) => [name, { defaultEnabled: false }]),
    ),
    sharedServices: [
      ...new Set(["core.records", ...(featureServices[id] ?? [])]),
    ].map((service) => ({
      id: service,
      version: "^1",
      optional: false,
      ...(id === "email-client" && service === "files.access"
        ? { when: "attachments" }
        : {}),
    })),
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
export const schemaById = new Map(schemas.map((s) => [s.id, s]));
catalog
  .find((m) => m.id === "email-client")!
  .provides.commands.push(
    "mail.sync",
    "mail.read",
    "mail.send",
    "mail.applyOperation",
    "mail.folders",
  );
export const manifestById = new Map(catalog.map((p) => [p.id, p]));
export function getSchema(id: string) {
  const s = schemaById.get(id);
  invariant(s, "VALIDATION_FAILED", `Unknown collection: ${id}`);
  return s;
}
export function validateExtension(input: unknown, contracts: unknown) {
  const manifest = manifestSchema.parse(input);
  invariant(
    !isRequiredCore(manifest.id) && manifest.publisher !== "taskasaur",
    "RESERVED_PROVIDER",
    "Platform providers are updated by a platform release",
  );
  invariant(
    Array.isArray(contracts),
    "VALIDATION_FAILED",
    "Expected collection contracts",
  );
  const prefix = manifest.id.replaceAll(/[.-]/g, "_") + "_";
  const parsed: RecordSchema[] = contracts.map((contract) => {
    invariant(
      contract && typeof contract === "object",
      "VALIDATION_FAILED",
      "Invalid collection contract",
    );
    const schema = contract as RecordSchema;
    invariant(
      schema.pluginId === manifest.id &&
        schema.id.startsWith(prefix) &&
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
    return {
      id: schema.id,
      pluginId: manifest.id,
      name: String(schema.name),
      version: schema.version,
      fields,
    };
  });
  for (const command of manifest.provides.commands)
    invariant(
      command.startsWith(manifest.id + ".") ||
        parsed.some((s) =>
          [`${s.id}.list`, `${s.id}.put`, `${s.id}.delete`].includes(command),
        ),
      "RESERVED_PROVIDER",
      "Commands must use the plugin namespace",
    );
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
