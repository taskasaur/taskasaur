# Shared column customization

A plugin opts into independently configured tables with `RecordSchema.tables: true`. Core creates each new table with only the fields required by its contract or standard. VTODO requires UID/DTSTAMP; VEVENT without METHOD also requires DTSTART; VALARM requires ACTION/TRIGGER and validates its conditional fields when saving. Generated required fields do not need manual entry. A contract with no required fields may have an empty column list. Existing user-configured tables are preserved.

The Columns page lists optional standard fields as clickable **templates**. Adding one copies a descriptor into that table; it can then be renamed, reordered, removed, or customized. Optional templates are not permanently locked to their original type. Required standard contracts remain locked. The generic Tables UI uses the same `ColumnEditor` and codecs as plugin tables.

## Type and number of inputs are separate

```ts
field("scores", "Scores", "integer", {
  storage: "custom",
  inputMode: "multiselect",
  array: true,
  options: [1, 2, 3, 4, 5],
  minItems: 1,
  maxItems: 3,
  required: false,
  nullable: true,
  default: [3],
  visibility: "editable",
});
```

`pgType` describes one value. `inputMode` describes how many values and how they are entered:

| Input mode    | Stored shape            | Control                                       |
| ------------- | ----------------------- | --------------------------------------------- |
| `single`      | scalar (`array: false`) | Base-type input                               |
| `select`      | scalar                  | Shared select with typed options              |
| `list`        | array                   | Repeatable base-type inputs                   |
| `multiselect` | array                   | Multiple typed selections, without duplicates |

`minItems`/`maxItems` constrain list length; equal values specify a fixed number of inputs. Options retain the scalar's type: integer options are numbers, booleans are booleans, and exact numeric/bigint options are strings. Core validates option types, duplicates, count limits and defaults. `required` controls absence; `nullable` controls explicit null. Scalar type constraints remain those of the shared PostgreSQL descriptors.

Visibility is a presentation choice, not access control:

- `editable`: show an editable control.
- `viewable`: display in forms with editing disabled; plugins can populate it through core.
- `hidden`: omit from forms and collection displays.
- `addable`: show when populated, otherwise expose through the optional-fields disclosure.

Required hidden/read-only columns need a default or generated value. Every platform and plugin uses `FieldInput`, `RecordForm`, `ColumnEditor` and the shared collection presentation rather than its own codecs or native select elements.

## Storage and interoperability

User columns live in `custom_fields`; generic table rows use `values`. `storage: "custom"` distinguishes an independently configurable template copy from a locked standard field. Core mirrors compatible values into the original optional standard property so existing plugin operations, calendars, reminders and APIs keep working. Explicit plugin updates also update a compatible template copy. A custom type or option without a valid standard representation stays in `custom_fields`; a plugin must not reinterpret it as a different standard value.

Collection cells and forms use the configured display columns. Plugin action callbacks and execution controls receive the canonical record and write through core. A user changing the Status template to a numeric column therefore does not change the task completion operation or overwrite that numeric value.

Removing a column hides it without erasing its stored values. Re-add its stable ID to expose those values again. Editing a table validates its existing rows; an incompatible type change is rejected instead of silently coercing data. The table definition itself replicates through Automerge. Selected table, view configuration and local search projections remain device state.

Use `collectionColumns`, `customValues`, `templateValues` and `validateTableValues` from the SDK when adapting a legacy store. Ordinary plugins use core records and receive this validation automatically. Standard conditional requirements remain enforced independently of which optional templates the user has selected.
