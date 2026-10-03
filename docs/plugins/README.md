# Taskasaur plugin specification

The authoritative SDK is the npm workspace at `packages/platform` in this repository. A plugin is a signed, downloadable package; its inventory URL may be hosted on any approved HTTPS origin. The inventory and optional plugin source repositories remain separate from the app. See [inventory format](../plugin-inventory.md).

## Required contract

Every plugin supplies `plugin.json`, `schemas.json`, a license and bundled module entrypoints. The manifest declares a stable namespaced ID, semantic version, publisher, platform/field API versions, dependencies, permissions, shared services, collections, commands, events and UI surfaces. Core validates these declarations before activation. A publisher cannot replace required core providers or another plugin’s collection/command namespace. Activation returns cleanup, observes `context.signal`, and must finish within 30 seconds.

All cross-plugin and cross-device communication goes through `context.messages`: JSON-RPC 2.0 commands and CloudEvents 1.0 events. Declare `provides`/`consumes`; consumed capabilities require grants. Use a stable mutation/operation ID for side effects. State synchronization is not command delivery. Commands are authenticated at the receiving peer, and target-device selection is preserved. Do not open a private device gateway, import another plugin’s internal implementation, or write its data store.

All persisted fields use the shared PostgreSQL-based descriptors in `@taskasaur/platform/field-types`: text, booleans, integer widths, numeric/decimal strings, dates, times, timezone-aware timestamps, intervals, UUIDs, enums, arrays, JSONB and binary references. Use the exported codecs and validation. Int64/numeric values must not silently become floating-point numbers. UI inputs use core `FieldInput`, `RecordForm`, `RecordTable` and the local shared component library. Required fields appear before optional fields. Calendar/reminder schemas retain their iCalendar validation. Markdown parsing is not an application storage layer.

The [complete field mapping](fields.md) specifies every supported type, portable encoding and shared input, including nullability and precision rules.

## Entrypoints

- `entrypoints.core`: portable TypeScript logic bundled as `core.mjs`, activated on browser/mobile/desktop and headless peers. It must use portable APIs and core services. The build wrapper resolves allowed SDK imports through declared/granted `core.modules`.
- `entrypoints.browser`: optional shared UI, bundled as `browser.mjs`. It can register declared surfaces through `core.ui`. On native mobile and desktop this is still the shared web UI.
- `entrypoints.server`: compatibility name for an optional native module on a desktop/headless peer. It runs inside the app’s native plugin host after local opt-in. Existing v1 packages use `core.server` and `createBackend(core)` for declared HTTP, mutation and background hooks. SQL access is an embedded local projection, never a remote database connection.

Core and platform entrypoints may coexist; activation/cleanup are composed. Disable only capabilities unsupported on a platform. A plugin with no native requirements needs no native entrypoint. Native code is trusted publisher code, not sandboxed JavaScript. Browser code shares the app’s origin; grants enforce the SDK contract rather than isolating a hostile publisher.

## Shared services and opt-ins

Required app providers are access control, records/fields/modules, local storage, peer sync, settings, variables, tables, files, credentials, devices/peers, jobs/schedules and notifications. These cannot be uninstalled. A feature plugin explicitly declares the services it needs; mark a service `optional: true` and use `services.optional()` when the plugin can function without it. Feature-gated services use `when` and a feature whose default is disabled.

| Service                                               | Contract                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `core.records`                                        | Scoped collection get/list/put/delete, shared validation and durable core writes             |
| `core.storage.local`                                  | Scoped Dexie query/subscription projection; core owns its database/version and replication   |
| `core.fields`                                         | The same schema descriptors, codecs and validators used by forms and native adapters         |
| `core.modules`                                        | Portable SDK runtime imports for a core entrypoint                                           |
| `core.ui`                                             | Locally maintained shared React components, tables, filtering/sorting and declared surfaces  |
| `core.settings`                                       | Nonsecret, plugin-scoped replicated preferences; do not put credentials here                 |
| `core.sync`                                           | Synchronize and inspect replica status; no server cursor or authoritative server row         |
| `core.devices`                                        | Compatibility list of device records                                                         |
| `core.peers`                                          | Typed current identity, approved peers, online state and capability discovery                |
| `files.access`                                        | Read/write core file bytes and immutable versions                                            |
| `credentials.use`                                     | Broker a declared operation with an approved credential/destination; never enumerate secrets |
| `core.jobs`, `core.schedules`                         | Durable, explicitly assigned work; external operations require idempotency                   |
| `core.notifications`, `core.variables`, `core.tables` | Shared typed resources                                                                       |

The Dexie projection is not a second authority. Do not use its raw IndexedDB tables to bypass core writes, or imply a multi-document distributed transaction. Save completion means durable local commit. Keep ephemeral UI state separate from replicated settings. Newer schema data must be retained when a device has an older plugin; update the plugin before editing it.

```ts
import type { CoreContext } from "@taskasaur/platform/plugin-sdk";
import type { PeerService } from "@taskasaur/platform/plugin-sdk/peers";

export default {
  async activate(context: CoreContext) {
    const peers = context.services.optional<PeerService>("core.peers");
    const candidates = peers ? await peers.list() : [];
    // Render an explicit choice. Never select a different execution device on retry.
    async function executeOn(deviceId: string, operationId: string) {
      return context.messages.call(
        "my-plugin.process",
        { value: "example" },
        {
          targetDeviceId: deviceId,
          mutationId: operationId,
        },
      );
    }
    // Register declared commands/events with context.messages.handle/subscribe.
    return () => {
      /* dispose subscriptions, timers and UI */
    };
  },
};
```

## Packaging, install and update

Use `@taskasaur/platform/build-plugin` with source entrypoints in `src/core.ts`, `src/browser.tsx` and/or `src/server.ts`. Bundle ordinary dependencies; runtime peer SDK/UI imports are resolved by core. Keep packages small and lazy-load large optional editors. Include dependency license notices. `packPlugin` in the native package tools creates an Ed25519-signed ZIP containing `package-index.json`, `package-signature` and hashes/sizes of every included file. The complete ZIP’s SHA-256 is pinned by its inventory entry.

Installation downloads with a size limit, validates paths, verifies the trusted publisher signature and every hash, checks API compatibility/dependencies and asks for the declared grants. Browser sources are verified again before activation. Native packages use an atomic staged install and revalidation before loading. Replacing bytes under an existing version, silently downgrading, or removing stored fields without migration is rejected.

Approval is per device. Synchronizing records or a package recommendation never executes downloaded native code. The app’s Devices page installs reviewed native dependencies on an explicitly selected, opted-in computer. Account/background services have an assigned computer; they do not fail over automatically during a partition. Disable a service on its old computer before changing its assignment to prevent concurrent external effects.

Test clean install, restart, disable/uninstall/re-enable, offline CRUD, a second peer with the plugin absent, independent/conflicting edits, schema upgrades, revoked/read-only devices, duplicate command IDs, file download interruption, credential denial and disposal. Data must remain recoverable when code is disabled or unavailable. Existing v1 terminal, sharing and office UI packages are adapted by the host to peer terminals, workspace-level sharing and portable offline editors. Their old central gateway/account interfaces are not used. The office surface is available only after installing the signed Office Editor plugin.

## Portable service method contracts

`core.records.collection(id)` and `core.storage.local.collection(id)` expose `list(query?)`, `get(resourceId)`, `put(data, resourceId?)` and `delete(resourceId)`. Always await writes. Use the same explicit resource ID when updating a record; native v1 modules may also use the legacy options object. Collection access is restricted to the declaring plugin. Multi-record transactions are unavailable (`capabilities.multiRecordTransactions === false`); requesting one fails before the callback runs. Build compound actions from individually durable writes and declared idempotent commands.

`core.settings.get(key)` returns a promise; `set(key, value)` stores nonsecret replicated JSON under the plugin namespace. `core.sync.synchronize()` exchanges available changes, while `status()` returns local document/change counts, pending dependencies, quarantine count and peer/error state. `core.peers` is typed in `plugin-sdk/peers`.

Record IDs, mutation IDs and CloudEvent IDs are UUIDs. JSON-RPC operation IDs may additionally include a bounded step suffix. Events are immutable; reusing their IDs for different content is rejected. Execute side effects in commands or assigned background services, never in projection callbacks. Moving a background service requires its previous device to stop accepting work, drain and sign a release; an offline device cannot be silently replaced.

## Shared credentials

Declare and obtain a grant for `credentials.use`. Its portable `request(credentialId, destination, { method?, body? })` method performs an HTTPS JSON request with Bearer or Basic authorization supplied by core and returns only the response JSON. Core checks the calling plugin, credential owner, selected device's sealed access and the exact allowed destination. Redirects are disabled, requests time out after 15 seconds and response bodies are limited to 1 MiB. Use `core.peers` and a targeted command to run an integration on a device capable of reaching its provider; browser requests remain subject to CORS.

Store secrets through the Credentials UI, never through record fields, plugin settings or a plugin-owned vault. OAuth secret keys are `access_token`, `refresh_token`, `token_endpoint`, `client_id`, optional `client_secret`, and `expires_at`; ordinary password credentials use `username` and `password`. An API credential uses `api_key`. Native v1 adapters also receive the legacy camel-case aliases. Refresh requires the token endpoint in the approved destination list, runs on the issuing device, is serialized per credential and reseals the result to the approved recipients. The issuer must be online when another device needs a refresh. Enabling an integration on a second computer does not automatically grant that computer the secret.
