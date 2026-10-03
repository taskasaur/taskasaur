# Shared collection views

Use `RecordTable` for plugin collections. It supplies the shared Filter, Sort, Columns, Group and View controls, durable device-local preferences, permission checks, schema-based forms and all six presentations. The Columns button always says **Columns**. There is no free-text entry search; use a typed filter. Opening a control closes the previous control in the same table. Nested field selects remain part of their parent popup.

```tsx
/// <reference types="@taskasaur/platform/host-types" />
import { RecordTable } from "@taskasaur/ui/record-table";

<RecordTable
  runtime={ui.workspace}
  collection="example.entries"
  viewKey="example.entries.main"
  defaultView={{
    mode: "short-table",
    columns: ["title", "status", "priority"],
    groups: [
      { id: "status", field: "status", enabled: true },
      { id: "priority", field: "priority", enabled: true },
    ],
  }}
/>;
```

Import the component through `core.ui.modules`, or use `core.ui.RecordTable` directly without its `runtime` prop. Core checks declared collection access for both. Tables in separate surfaces should use distinct, stable `viewKey` values when their preferences should differ. Preferences are local to this device and workspace; they do not execute or schedule replicated work. Existing `groupBy` preferences migrate to the first grouping rule; retired saved entry searches are discarded. A new `defaultView` is used only when no saved preference exists.

## Rules and data

Filters and sorts use `@taskasaur/platform/field-types`. Filter rules are applied from top to bottom, joining each subsequent enabled rule using its And/Or setting. Up/down buttons change that order. Turning a rule off retains its configuration. The first filter's Where label occupies the same column width as subsequent And/Or selectors. Sort rules have the same ordered, enabled model; clicking a column header promotes that field to the first sort. Sort and Group rows place their enable switch immediately after the up/down arrows.

Columns uses the same arrows and switches in a searchable popover; its search only finds column names. Column order is saved separately from visibility, so hiding and showing a field preserves its position. `columnOrder` stores all field IDs, while `columns` contains the visible IDs in display order. Existing preferences migrate automatically; custom `QueryControls` consumers can persist the optional order argument from `onColumns(visibleIds, orderedIds)` and pass it back as `columnOrder`.

Group rules contain `{ id, field, enabled }`. Enabled fields partition the already filtered and sorted rows recursively, in rule order. Each leaf retains the input sort order. Groups are ordered by the shared typed comparator; unset values appear last. Group IDs are based on field IDs and canonical values, not display labels. Large integers and decimals retain precision; timezone-aware instants retain microseconds. Equivalent numeric representations and timestamp offsets share a group. JSON objects use sorted keys; arrays group by the entire ordered array rather than multiplying records across values. Missing and null values share the **Not set** group. Duplicate enabled fields are ignored defensively, and the UI prevents adding duplicates.

All six views use one path of `{ field, key }` segments, one breadcrumb and one collapsed-group set:

| View               | Presentation                                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Short table        | Fixed-width table, aggressively wrapping cell content.                                                                   |
| Long table         | Unwrapped cells, horizontal scrolling within the table.                                                                  |
| Board              | Nested horizontal groups; field/value headers remain visible horizontally within their group. Leaf groups contain cards. |
| Short table folder | Group folders at each depth, then the short table at the leaf.                                                           |
| Long table folder  | Group folders at each depth, then the long table at the leaf.                                                            |
| Board folder       | Group folders at each depth, then cards at the leaf.                                                                     |

A group heading includes field, value, record count, collapse/expand and a right-arrow open action. Opening a group restricts the displayed subtree and appends a breadcrumb; selected ancestor headings remain above its contents. Folder clicks perform the same navigation. Breadcrumb ancestors return to the corresponding depth. Changing view preserves the path. A path whose values disappeared or whose grouping order changed resolves to its longest valid prefix. Without grouping rules, folder modes show their underlying record view immediately.

## Extension points

`RecordTable` accepts `toolbar`, `onOpen`, `renderActions`, `hideCreate`, `readOnly`, `schemaOverride`, `storeOverride`, `columnOptions`, `renderCell` and `renderCard`.

- `columnOptions[fieldId]` can set `header`, `width` and `className`; keep field IDs aligned with the schema.
- `renderCell(context)` receives `row`, `field`, `value`, `defaultContent`, `writable` and `update(patch)`. Return `defaultContent` for fields without a specialized display. This is the extension point for future inline editors. Only enable editing when `writable` is true; await `update`, handle its rejection and retain the user's draft on errors. The host rechecks access, reads the current record and merges the patch through the collection store. Core validation and durable write behavior remain in force. This is not a cross-device transaction.
- `renderCard(row, defaultContent)` customizes card contents while retaining the shared board/group navigation. `renderActions(row, { writable, update })` adds record actions in tables and cards using the same permission-checked update path.
- `storeOverride` must preserve the core collection contract and permissions; it does not grant access. Writes resolve after durable persistence.

For specialized storage adapters, compose the exported pure `CollectionView`, `QueryControls`, and functions/types in `@taskasaur/ui/collection-view-model`. Pass rows already filtered/sorted by `queryRecords`, normalized `CollectionViewState`, and an `onChange` callback. `CollectionView` never writes storage itself. Supply `writable` and `onUpdate` to support editable cells; absent callbacks make its update context read-only. Keep the shared rule controls and breadcrumbs instead of implementing a parallel system.

## Shared components and compatibility

The local primitives were downloaded with the official [shadcn CLI](https://ui.shadcn.com/docs/cli), using the Base UI `base-nova` registry. `packages/ui/shadcn-registry.json` records the command, CLI version, date and SHA-256 hashes. `npm run ui:verify` ensures all 24 downloaded source files remain unchanged. Theme tokens use shadcn's neutral defaults; application layout and view composition live outside primitives. To update, run the recorded command with the current CLI, inspect its dependency changes, refresh the provenance hashes, regenerate UI declarations and run the browser checks.

Use `FieldInput` and `RecordForm` for schema fields, `ChoiceSelect` for application choices, and `@taskasaur/ui/primitives/*` for composed controls. Every downloaded primitive is exported in the host module map. These use Base UI's `render` composition prop, not Radix's `asChild`. Do not bundle another React instance or copies of the core components. The generated host declarations reflect the actual component APIs (`npm run ui:types`, also part of `sdk:build`). Plugin TypeScript projects that import primitive types need matching development type dependencies: React, Base UI, class-variance-authority, react-day-picker and sonner as applicable. Runtime UI imports remain external through the standard plugin builder.

Existing signed v1 plugins receive a compatibility React/JSX facade mapping their intrinsic select, input, checkbox and textarea elements onto the downloaded controls. It preserves their value/change boundary without modifying signed package bytes. New plugins should use explicit shared components; the compatibility adapter is not a complete emulation of HTMLSelectElement methods or DOM refs. The v1 Tasks surface uses the shared collection view with its completion action, replacing its separate board implementation.

## Verification

`tests/collection-view.test.ts` checks recursive partitions, exact typed identities, stale breadcrumbs, migration and rule ordering. `tests/browser/collection-views.mjs` exercises real plugin installation and CRUD, filtering, ordering, column selection, exclusive popups, collapse/drill-in, all six modes, reload persistence and narrow viewports. Run it against a running web app using `TEST_APP_URL`. The published-plugin and offline browser suites cover host compatibility and downloaded-package behavior. Future inline editors should add keyboard, focus, validation, read-only and concurrent-update checks here.
