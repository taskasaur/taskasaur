# Plugin navigation, search and tables

Core owns the application shell. Installed optional plugins appear in the left menu; Files, Tables, Variables, Credentials, Devices, Notifications, Jobs and Settings appear in the right menu. The desktop top bar and mobile bottom bar open those menus and show up to three saved plugin shortcuts. Shortcuts and the selected data table are device-local preferences. The top breadcrumb identifies the workspace, plugin and subpage. Plugins render their content without another workspace/page header.

## Pages and icons

Declare a main page and any additional pages in `plugin.json`:

```json
{
  "ui": {
    "mode": "shared",
    "apiVersion": "^1.0.0",
    "icon": "tasks",
    "mainPage": "home",
    "surfaces": ["home", "preferences"],
    "pages": [
      { "id": "preferences", "label": "Preferences" },
      {
        "id": "history",
        "label": "History",
        "collection": "example_history",
        "readOnly": true
      }
    ]
  }
}
```

Register a render function for each custom surface through `core.ui.registerSurface({ id, label, render, main?, icon? })`. Core renders collection-only pages using its shared RecordTable. The plugin's main button always opens its main page; the adjacent chevron expands its subpages. Active subpages appear in both the button and the breadcrumb. Core automatically supplies a Columns page for each collection with tables enabled. The top bar shows buttons immediately after the breadcrumb for every other page of the current plugin, including its main page when viewing a subpage. The current page is omitted from these buttons. This uses the same page declarations as the menus, with no extra plugin registration. On narrow screens the breadcrumb and page buttons scroll horizontally together.

Icons are local Lucide icons. Built-in plugin IDs each map to a distinct icon; use one of those names through `ui.icon` for a supported icon, or omit it to get a deterministic identicon unique to the plugin ID. Core never fetches executable or remote image markup for navigation. A single legacy surface is inferred as the main page. The published Mail v1 adapter moves Accounts and Operations into subpages without losing its compose/receive functionality.

## Commands and content search

Search uses the downloaded shadcn Command component. Users open it from the first item in the left menu or with Cmd/Ctrl+K. Content results and commands share one palette. Core automatically provides navigation commands for every enabled plugin page.

The `core.ui` service also implements `NavigationService` from `@taskasaur/platform/plugin-sdk/navigation`:

```ts
import type { NavigationService } from "@taskasaur/platform/plugin-sdk/navigation";

export async function activate(context) {
  const ui = context.services.require<NavigationService>("core.ui");
  const removeCommand = ui.registerCommand({
    id: "open-preferences",
    title: "Open my plugin preferences",
    keywords: ["configure", "options"],
    run: () => ui.navigate("preferences"),
  });
  const removeSearchOptions = ui.configureSearch({
    collection: "example_notes",
    titleField: "title",
    fields: ["title", "body"],
    page: "home",
  });
  return () => {
    removeCommand();
    removeSearchOptions();
  };
}
```

Declare and obtain the `core.ui` shared service as usual. Command IDs are scoped to their plugin. Registration is not execution: only explicit user selection invokes `run`, and the callback must still use the ordinary permission-checked services/messages. Optional `enabled()` determines availability. Disable, uninstall, activation failure and host disposal remove registrations. Return the disposers from activation for earlier cleanup.

No search declaration is needed for ordinary records. Core derives titles and indexes safe scalar/array fields using their descriptors, including custom table columns. Credential search includes names and providers only; secret/password fields, binary fields and arbitrary JSON payloads are excluded. `configureSearch` may narrow indexed fields, set a title field, change the result page or disable a collection's content search. It cannot enable indexing of protected fields or another plugin's collection.

Core also extracts locally available plain-text files and Taskasaur office document text (files up to 4 MB, capped at 200,000 text characters). Binary office formats, HTML and executable text are not parsed by this index. Results use accent-insensitive token-prefix matching; searching never downloads remote files.

The `searchDocuments` Dexie table is a rebuildable index local to each workspace/device. It does not enter Automerge, peer messages, the outbox or workspace record exports. Before querying, core updates changed documents and removes deleted, disabled and unavailable records. Access reconciliation deletes cached documents for revoked records. Search results select the correct data table and open the record through the shared table's existing `onOpen`/editor behavior. Plugins do not need to maintain a separate search index.

## Independent data tables

Set `tables: true` on a collection schema to use the shared table framework. Tasks, Time, Calendar, Reminders, Track and Mail v1 collections are adapted automatically. These definitions remain owned by the optional plugin; core provides storage, validation, selectors and the Columns page.

A collection retains its stable ID and command names. Each entry has a core-managed `table_id` and `custom_fields` object. Standard fields remain at their original keys, so automation, scheduling and account integrations retain their existing contracts. Custom values use the same PostgreSQL descriptors and field components as all other values.

Table definitions are ordinary replicated `tables` records with `collection_id`, `columns`, `is_default` and immutable `managedBy` provenance. Core creates a deterministic default table per workspace/collection; pre-existing entries without `table_id` belong to it. Default tables preserve the existing column set. New tables start with required columns, or one optional title field when the format has no required columns. Additional standard columns are available as presets; custom columns support every base PostgreSQL type and arrays.

RecordTable and the browser workspace collection facade follow the selected table. Core/native message operations remain collection-wide and can explicitly supply `table_id`; background work never depends on a UI preference. Updating an existing entry retains its table. Each table has independent filter/sort/group/view and column-order preferences. Moving between tables does not move records.

The Columns page supports labels, preset addition/removal, custom columns and custom types. Mandatory columns cannot be removed, and standard field contracts cannot be weakened or retyped. Core validates custom values on the shared write path on every platform. Schema changes are rejected if existing values would become invalid or be silently lost; clear or migrate those values through the owning plugin before removing/retyping a populated custom column.

## Standards and required values

| Collection | Required values                   | Notes                                                                                                                                                                                                                                                      |
| ---------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks      | UID, DTSTAMP                      | Generated by core. Title/SUMMARY, status, due date and other VTODO properties are optional. [RFC 5545 §3.6.2](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.2).                                                                                       |
| Calendar   | UID, DTSTAMP, DTSTART             | This app stores standalone VEVENT data without METHOD. UID and DTSTAMP are generated. [RFC 5545 §3.6.1](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.1).                                                                                             |
| Reminders  | ACTION, TRIGGER                   | DISPLAY additionally needs DESCRIPTION; EMAIL also needs SUMMARY and ATTENDEE. Relative triggers need their parent/start-or-end relationship. REPEAT and DURATION occur together. [RFC 5545 §3.6.6](https://www.rfc-editor.org/rfc/rfc5545#section-3.6.6). |
| Time       | Start                             | Required by the timer/duration runtime. Title, kind and end are optional; a running timer has no end. This is an application interval contract, not a claim that a universal time-tracking standard requires these fields.                                 |
| Track      | None beyond the resource envelope | General tracking has no imposed domain standard.                                                                                                                                                                                                           |
| Mail       | Drafts may be incomplete          | Sending requires an account and recipients. The mail library constructs Date and From; other RFC header fields remain optional. [RFC 5322 §3.6](https://www.rfc-editor.org/rfc/rfc5322#section-3.6).                                                       |

Required transport identifiers and plugin runtime fields in account/job schemas remain required by their actual libraries. Being mentioned in a standard alone does not make an optional property mandatory.

## Managed shared resources

The shared services and declared cross-plugin CRUD commands stamp newly created Tables, Variables, Credentials and Files with the creating plugin's `managedBy`. Browser and native paths preserve this provenance on later updates. Referencing an existing user-created credential or file does not transfer ownership.

`core.tables` and `core.variables` provide `list`, `put(data, id?)` and `delete(id)`; their direct mutation methods only edit resources owned by that plugin. Use explicitly declared/granted cross-plugin commands when modifying other shared resources. `core.tables.rows(id)` reads rows. Files and credential operations retain their established shared services and permission checks; metadata creation can use declared `files.put` or `credentials.put` commands.

All shared resources remain visible in the core storage pages. A managed resource has a “Managed by …” label and no manual edit/delete/secret-setting controls there. Plugin tables open as read-only projections in Tables. The owning plugin's scoped shared components can edit them normally. Disabling a plugin retains its data and ownership; it does not expose the stored data for accidental manual edits.
