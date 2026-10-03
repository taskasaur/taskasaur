# Per-item execution

Execution is an opt-in trait of an item type. It is never a workspace-wide or plugin-wide computer preference. An automation, email account, repository connection, or several independent execution slots on an item can each select a different approved device. Tasks, files, notes and other replicated content need no target.

The required Devices core provider supplies `core.execution`; feature plugins opt into consuming it through `sharedServices` and its grant. Use `core.peers` for general device discovery. All execution commands still travel through the existing authenticated JSON-RPC messenger; no separate transport or plugin-owned gateway is needed.

## Manifest

Declare `execution` in `plugin.json` (an optional array). For example, a plugin owning `example_export_accounts` can add:

```json
{
  "execution": [
    {
      "id": "export",
      "collection": "example_export_accounts",
      "label": "Export execution",
      "plugins": [{ "id": "example.export", "version": "1.0.0" }],
      "capabilities": ["background.execute"],
      "commands": ["example.export.send"],
      "references": [
        { "collection": "example_export_jobs", "field": "account_id" }
      ],
      "background": { "command": "example.export.send", "intervalSeconds": 300 }
    }
  ],
  "sharedServices": [
    { "id": "core.execution", "version": "^1", "optional": true }
  ]
}
```

Merge these entries into the full manifest, declare the command in `provides.commands`, and define both owned collections in `schemas.json`. `account_id` must be a scalar UUID referencing the account. A command accepts `{ id: <account-or-child-record-id>, ... }`; core resolves child references to their parent execution item. A scheduled command receives `{ id: <execution-item-id> }`. Commands and exact native HTTP `routes` (without wildcard suffixes) must be declared in the usual manifest contracts. Slot IDs are stable and unique within the plugin. A route or command must resolve unambiguously to one slot for a given record.

`plugins` adds requirements to the owning plugin and its transitive manifest dependencies. An omitted version accepts an installed release; a supplied version requires that exact semantic version. `capabilities` are exact feature IDs, not wildcard permissions. Native integration slots should request `plugins.native`, and recurring work requires `background.execute`. Automation additionally requires `automation.execute`; TypeScript nodes require `automation.typescript` and the existing trusted-author permission. Required command providers are inferred from automation graphs.

Optional `targetField` and `enabledField` mirror the assignment into existing UUID and boolean fields. New plugins can omit both: core owns the assignment, enable state, generation and handoff records. Do not write core's internal assignment records or start work from raw replicated target fields.

The current signed v1 automation, mail and GitHub packages receive compatibility declarations in the host without changing their package signatures. Automation settings appear in the graph editor and workflow table; mail accounts and GitHub connections get the same execution action in their tables. Old plugin-wide service settings are retained as data but do not authorize these item executions. Existing workflows need an explicit item assignment before they run.

## Shared UI and service

Use `RecordTable` for a declared collection: core automatically adds an **Execution settings** row action and opens it after creating an execution item. It omits mirrored fields from the ordinary record form. In a custom editor, use `ExecutionTarget` from `@taskasaur/ui/execution-target` with the scoped `runtime`, `resourceId` and optional `slotId`. Alternatively, `core.ui.ExecutionTarget` binds the runtime for you and needs only `resourceId` and optional `slotId`. The module wrapper replaces the scoped facade with the host runtime internally and enforces collection access. `readOnly` can further restrict the control. This is the same locally installed shadcn composition across all platforms.

The optional service is typed in `@taskasaur/platform/plugin-sdk/execution`:

```ts
const execution = context.services.require<ExecutionService>("core.execution");
const slots = execution.definitions();
const state = await execution.inspect(accountId, "export");
await execution.configure(accountId, {
  slotId: "export",
  deviceId: selectedComputer.id,
  enabled: true,
});
```

Declare the service grant before using it. `definitions()` lists the plugin's slots. `inspect` returns the current binding and device candidates with online state, actual installed versions, enabled state, missing plugins/capabilities and remote-install permission. Offline devices are explicitly unknown, never ready. Configuration requires workspace write access; cross-plugin access also requires declared/granted collection list/put commands. Select a device with write access; viewer devices cannot execute or receive assignments.

Save drafts anywhere. Assign and enable an automation before publishing/running it. Its selected computer remains authoritative when a different device authors or starts it. Availability requires that computer's app/runner to remain active; a suspended phone or closed browser cannot execute background work. Missing credentials are still governed by the shared credential broker: installing a plugin does not grant access to secrets.

## Reviewed remote installation

The shared picker shows **Review plugin installation** when required packages are absent, disabled, incompatible or failed. It builds a dependency-ordered plan from the configured signed inventory, shows versions and grants, and pins each SHA-256 before installation. The workspace owner confirms installation on the selected computer. `core.plugins.install` rechecks owner authorization, device-local opt-in, inventory/version/digest, signatures and permissions. It enables installed packages and dependencies, then refreshes status. Partial failure leaves successful packages installed and reports the error; review/retry the remaining plan.

The destination must enable remote installation locally in **Devices** (or its headless startup options). Installation does not turn on terminal access, background services or trusted TypeScript. Capability switches belong to that device. The UI identifies missing capabilities after installation. `core.plugins.status` is a live, authenticated, read-only RPC and can be inspected by viewers; install/configure remain restricted.

## Routing, pause and handoff

The messenger derives the target from the operation's declared execution item. An explicit conflicting target is rejected. There is no first-available-computer fallback. Native and portable command receivers independently enforce the current binding and enable state. Native jobs store the assignment generation and are claimed only on that device and generation. Background schedules enumerate enabled items assigned locally; merely receiving record changes never creates an accepted automation run.

Turning an item off blocks new work and pauses automation progress at step boundaries. In-flight external operations may finish; already submitted SMTP/HTTP effects cannot be undone. Offline computers observe pause changes only after synchronization. Other items keep their settings and continue independently.

Moving an item requires the previous computer to be reachable. It durably stops accepting work, drains item operations, cancels unfinished automation runs on that computer, and signs a release naming the next device and generation. Old queued work cannot take over the new generation. Run history remains; moving an item does not transplant a running process or its checkpoint state. If the previous computer is offline, the move fails instead of silently assigning another executor. Concurrent conflicting assignments fail closed and require resolution. This is not an exactly-once guarantee across network partitions or arbitrary external providers: plugins must preserve stable operation IDs and handle ambiguous external outcomes.

Declare references for child records so background events resolve to their owning execution item. Native event subscribers run only for declared locally assigned items; use content-only portable handlers for ordinary UI/data events. Multiple slots sharing a collection must have distinct commands/routes and should use scheduled commands rather than ambiguous event ownership. For manual device-only commands such as terminals, an explicit target remains valid without an item slot.

Tests cover independent targets, pause isolation, status/version/offline reporting, viewer restrictions, successor fencing, generation persistence and the native/portable automation paths. Plugin acceptance should also exercise lost connections, disabled dependencies, missing credentials, remote install denial, duplicate operation IDs, process restart and handoff while external work is active.
