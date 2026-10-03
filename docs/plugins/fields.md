# Shared field contract

Every persisted plugin field uses a descriptor from `@taskasaur/platform/field-types`. PostgreSQL names define the value semantics even on devices that use an Automerge journal and a Dexie projection instead of SQL. Native PGlite adapters use the same descriptor. Do not infer a different type from a particular widget or JSON value.

| PostgreSQL definition         | Portable value                                          | Shared `FieldInput`                                                        |
| ----------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `text`                        | Unicode string                                          | Text input; declared textarea, email, URL or password control              |
| `character varying`           | String with optional maximum code-point length          | Text input with shared validation                                          |
| `uuid`                        | Validated lowercase UUID string                         | Reference selector when `reference` is declared; otherwise text input      |
| `boolean`                     | Boolean                                                 | Switch; nullable fields use Not set / Yes / No                             |
| `smallint`                    | Integer number, −32768 through 32767                    | Number input                                                               |
| `integer`                     | Signed 32-bit integer number                            | Number input                                                               |
| `bigint`                      | Exact signed 64-bit integer **string**                  | Text input that preserves every digit                                      |
| `numeric`                     | Exact decimal **string**, with optional precision/scale | Text input that preserves decimal precision                                |
| `double precision`            | Finite number                                           | Number input                                                               |
| `date`                        | `YYYY-MM-DD`                                            | Date input                                                                 |
| `time without time zone`      | `HH:mm:ss`, optional fractional seconds                 | Time input                                                                 |
| `timestamp without time zone` | Local date/time string without offset                   | Local date/time input                                                      |
| `timestamp with time zone`    | ISO date/time string with `Z` or offset                 | Local date/time input converted to an instant                              |
| `interval`                    | ISO duration string, such as `PT30M` or `-PT10M`        | Text input with duration validation                                        |
| `jsonb`                       | Finite JSON values, nesting limited to 40               | JSON editor with syntax validation                                         |
| `bytea`                       | Canonical base64 string                                 | Text input with base64 validation; use core Files for large binary objects |

`array: true` makes a typed array of the declared scalar, with shared add/remove controls. Array elements are non-null. `choices` constrains strings and supplies a select control; plugins do not create private SQL enum types. `reference` identifies a core collection and supplies its permitted options. File references are UUIDs, while file contents belong to core's versioned chunk storage.

`required` controls presence, and `nullable` controls whether an explicit null is accepted. Declare both `required: true` and `nullable: false` for a mandatory value. Optional absent fields become null unless a default is supplied. `RecordForm` places required and conditionally required fields first, with optional fields behind the shared disclosure. `RecordTable` uses the same field definitions for sorting, grouping and filters. A schema cannot silently accept undeclared fields.

Use `decodeField` for a field, `validateRecord` for a whole record, and core collection methods for persistence. Keep exact integer/decimal values as strings across messages and JSON serialization. Timezone-aware timestamps can retain microseconds in storage; the generic date/time input edits at second precision. A calendar date must never be implicitly interpreted as midnight UTC.

Calendar events and reminders additionally declare the `ical-event` or `ical-alarm` standard. The shared calendar validators enforce UID/DTSTAMP/DTSTART rules, date-versus-date-time values, recurrence, alarm action requirements and relative triggers. Do not replace those standard fields with an incompatible plugin-specific set. Legacy Markdown-typed content maps to ordinary text; core does not parse Markdown as application data.

Schema versions travel with records. A device may retain and synchronize unknown/newer schemas without loading the plugin. Editing requires its compatible schema. Publish a compatible migration when changing stored fields; disabling or uninstalling code must preserve the user's records and files.
