# Taskasaur plugin interface v1

Taskasaur plugins use the framework in `packages/plugin-sdk`, `packages/core`, and `server/plugin-packages.ts`. Application and plugin logic is TypeScript. The framework runs trusted publisher code in the app/worker process; its scoped services are an interoperability and authorization contract, not a sandbox for hostile JavaScript.

## Required providers

Every workspace contains these providers. They cannot be disabled or uninstalled individually; a platform image updates them together.

| Provider         | Core interface and responsibility                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `access-control` | `core.access`: authenticated user/workspace scope and resource grants                                      |
| `records`        | `core.records`, `core.fields`: PostgreSQL schemas, codecs, commands, revisions                             |
| `data-dexie`     | `core.storage.local`: one core-managed database per account/workspace, scoped collections and transactions |
| `sync-supabase`  | `core.sync`: durable mutation outbox, authorized PostgreSQL synchronization                                |
| `settings`       | `core.settings`: namespaced preferences with device/workspace scope                                        |
| `variables`      | `core.variables`: named values validated against PostgreSQL descriptors                                    |
| `tables`         | `core.tables`: user column definitions and native typed values                                             |
| `files`          | `files.access`: immutable binary versions, local durability and server storage                             |
| `credentials`    | `credentials.use`: encrypted secrets and destination/plugin-scoped use                                     |
| `devices`        | `core.devices`, `core.streams`: enrollment, capabilities, presence, server routing                         |
| `jobs`           | `core.jobs`, `core.schedules`: durable jobs and selected-device execution                                  |
| `notifications`  | `core.notifications`: persisted delivery state and user notifications                                      |

A required provider's presence does not grant every plugin its capabilities. Consumers declare each shared service, version, permissions and optional feature predicate. Resolve it with `context.services.require(id)` or `optional(id)`. Undeclared services and missing grants fail closed. Do not open another IndexedDB database, bypass the credential broker, or talk directly to another plugin's database tables.

## Artifact and installation

A package directory contains `plugin.json`, `schemas.json` and bundled ES modules named by its entrypoints. Use a publisher namespace such as `example.notes`; collection IDs use its SQL-safe prefix, such as `example_notes_entries`. Required core IDs and core command namespaces are reserved. Browser modules must use core's locally maintained UI and field inputs rather than shipping another React/UI runtime.

`plugin.json` is validated by `manifestSchema` in `packages/plugin-sdk/index.ts`. It declares `id`, `name`, `description`, `version`, `publisher`, `license`, `platformApi`, `fieldSchemaApi`, `entrypoints`, `ui`, `storage`, `permissions`, `dependencies`, `features`, `sharedServices`, `provides` and `consumes`. Platform and field APIs currently accept `^1.0.0`. Feature switches default off. JSON manifests cannot contain executable migration callbacks.

```sh
npm run plugins -- keygen /private/path/publisher-key
npm run plugins -- pack ./my-plugin /private/path/publisher-key/private.pem ./my-plugin.zip
npm run plugins -- verify ./my-plugin.zip ./trusted-publishers.json
npm run plugins -- install ./my-plugin.zip ./trusted-publishers.json example.notes.read example.notes.write core.records
```

The trust file maps publisher IDs to Ed25519 public PEM keys. Do not place private signing keys in the plugin directory. Installation verifies a signed file index, SHA-256 hashes, expanded size limits, safe paths, API compatibility, dependencies and explicit permissions. It stages immutable version directories before atomically replacing the inventory. Packages and grants persist in `PLUGIN_PATH` (default `.taskasaur/plugins`). Workspace owners then install/enable the package through Plugins. Removing a plugin preserves its records; required dependencies cannot be removed while installed dependents remain.

For Docker installations, run the installer inside the app so it uses the shared plugin volume and database settings. For the bundled Notes example, after signing the package and preparing the public trust file:

```sh
docker compose cp ./example-notes.zip app:/tmp/example-notes.zip
docker compose cp ./trusted-publishers.json app:/tmp/trusted-publishers.json
docker compose exec -T app node --import tsx scripts/plugins.ts install \
  /tmp/example-notes.zip /tmp/trusted-publishers.json \
  example.notes.read example.notes.write example.notes.count \
  core.records core.storage.local core.ui example_notes_entries.changed
```

The archive and public trust file must be readable by the container's `node` user. Grant only the declarations you have reviewed. Open Plugins in the workspace and install/enable Example Notes. The running hosts discover the verified package without rebuilding the application image. Its package, grants and records persist across app/worker replacement; container integration tests exercise this path.

Additive external schema upgrades preserve existing records and add validated nullable/defaulted fields transactionally. Removing collections/fields, incompatible native types or nullability changes stop for a reviewed migration. Keep the prior artifact and a database backup; automatic rollback of arbitrary third-party migrations is not provided.

## PostgreSQL fields and shared UI

`schemas.json` is an array of record schemas: `id`, `pluginId`, `name`, integer `version`, and `fields`. A field has a stable `id`, `label`, `pgType`, `nullable`, `required`, optional default/bounds/choices, and an optional shared control hint. Supported scalar types are text, character varying, UUID, boolean, smallint, integer, bigint, numeric, double precision, date, time without time zone, timestamps with/without time zone, interval, JSONB and bytea. Set `array: true` for a homogeneous PostgreSQL array.

Bigint and numeric use exact decimal **strings** on the wire. Bytea uses base64; instants require an explicit zone; date-only values never undergo timezone conversion. JSONB contains finite JSON, with bounded depth. Never place passwords/tokens in generic JSONB, variables, records, event payloads or logs. Credential references are UUIDs, not secret fields.

Use `validateRecord` before writes. Server constraints and authorization remain authoritative. Reuse `FieldInput`, `RecordForm`, `RecordTable` and `QueryControls` from `packages/ui` and `packages/app-ui`. Required/conditionally required inputs precede optional inputs. The eleven former Taskasaur field kinds are mapped in `legacyTypes`; former Markdown values become plain text. No Markdown task parser is part of this app.

## Commands and events

Commands use JSON-RPC 2.0 through core. A request has a unique `id`, `method`, and typed `params`; writes also carry a stable UUID mutation ID, resource ID and base revision. A retry retains the same mutation ID and payload. Changing the payload under an old ID fails with `IDEMPOTENCY_CONFLICT`; concurrent edits return `REVISION_CONFLICT`. Core supplies the authenticated principal. User-provided actor/workspace metadata never establishes identity.

Collections provide `<collection>.list`, `.put` and `.delete`. Custom commands must use the plugin namespace and be listed under `provides.commands`. Register them during `activate(context)` with `context.messages.handle(name, inputSchema, handler)`. Return its disposer from the activation cleanup. Consumers declare commands under `consumes.commands`, obtain a grant, and call `context.messages.call`. Device selection is an explicit option; unsupported/offline targets return a typed availability reason.

Events use CloudEvents 1.0 with stable operation ID, source `/plugins/<id>`, type `taskasaur.<event>.v1`, resource subject and a workspace-scoped data envelope. Declare published and consumed event names. Publish only after the owning transaction commits; durable server record changes write their event and state in the same transaction. Handlers must tolerate redelivery, using event IDs as receipts. Never use events as an authorization grant or place credential material in them.

The activation signal is aborted on deactivation. Dispose commands, subscriptions, timers and UI surfaces in the returned cleanup. Disabled plugins cannot continue making core calls. A plugin failure must not disable required providers.

## Local persistence

Declare `storage.local.mode: "dexie"` and every collection ID, then use core's scoped local adapter. `put` validates the record and commits the record/outbox together for synchronized collections. `local-only` writes stay on the device; `cache` projections accept server ingestion only. `observe` uses Dexie live queries. Never mutate the core outbox directly from a plugin.

Core file saves commit the Blob version and metadata pointer in one IndexedDB transaction. A UI may report “Saved on this device” only after that transaction succeeds. Server upload acknowledgements preserve newer local versions. Parent-version conflicts retain local bytes and require reconciliation. Secrets never enter this store.

## Verification

Run `npm run typecheck` and `npm test`. Package tests verify signatures and reject modified/unknown-publisher artifacts. Storage tests exercise permissions, mandatory providers, revision handling, late acknowledgements and file preservation. Runner tests verify TypeScript execution, target ownership, durable restart and duplicate submissions. See `docs/implementation-status.md` for platform/integration acceptance still outstanding; compiling an adapter is not evidence of device support.

Core automatically releases registered command handlers, event subscriptions and UI surfaces if activation fails or the plugin is disabled. Previously obtained service handles reject new operations after deactivation. Activation is limited to 30 seconds and cleanup to five seconds; a failing cleanup cannot prevent disable or block another plugin. The host reports a redacted failure code in Plugins and keeps the remaining workspace available. Return cleanup for your own timers/resources and honor the activation AbortSignal for in-flight work; these contracts do not turn trusted publisher JavaScript into a sandbox.
