# TypeScript automation

`openworkflow` 0.10.1 supplies durable workflow/step storage and workers. Taskasaur adds the graph interpreter and core adapters. Native runners use SQLite; server runners use PostgreSQL. Each engine uses the selected device UUID as its storage namespace. A runner refuses a graph assigned to another device.

Graphs contain typed input, transform, condition, wait, core-command, HTTP, TypeScript and output nodes. The shared editor uses the same PostgreSQL field descriptors/inputs as other plugins. Graphs are acyclic, bounded to 256 nodes/512 edges, and waits are bounded. Publishing pins the graph version; changing its content requires a new version. Run records retain the selected device and published version.

Dispatch either fails immediately for an offline device or waits for that device with a bounded expiry. Core never silently selects another runner. Native hosts poll through their authenticated device connection lease and report the assignment epoch. Core-command effects use stable mutation IDs, so retries do not duplicate a write. A native receipt database maps dispatches to durable engine runs; server dispatches retain engine run IDs in PostgreSQL. Restarted workers query run state to finish reporting outcomes instead of relying on an in-memory completion callback.

TypeScript nodes require the workflow's explicit trusted-code opt-in. They run in a bounded Node subprocess with imports disallowed and a limited environment. This is for trusted authors; a subprocess is not a hostile-code sandbox. Python is not an automation language or runtime. Native dependency build tooling is separate from workflow execution.

`tests/workflow.test.ts` exercises SQLite restart/recovery, duplicate dispatch keys, target rejection and TypeScript execution. `tests/integration/automation.ts` exercises PostgreSQL dispatch, an explicit server device, a durable wait and a core task creation command. Continue testing long-running recovery, cancellation, upgrades, revoked capabilities and native execution before release acceptance.

## Interpreter versions and triggers

New dispatches pin interpreter v2. The original `taskasaur.graph.v1` handler remains registered to recover existing checkpoints. V2 adds JSON-pointer mapping, filtering, bounded foreach bodies, embedded/pinned subflows, four-way parallel levels with deterministic joins, explicit success/error edges and durable named signal waits. Nested graphs are limited to four levels, loops to 1,000 items and a run to 10,000 node executions. Structured mapping has no expression interpreter; custom code is TypeScript only. The editor exposes each node's shared field form and connection condition.

Enabled published workflows can use manual, interval schedule, committed event or authenticated webhook triggers. Schedules retain occurrence cursors and `skip`, `once` or bounded `all` catch-up policy. Event configurations begin with future committed events and reauthorize each resource before dispatch. Trigger configuration changes apply to future occurrences. Every occurrence uses a stable dispatch ID and the saved device; failed scheduling remains visible in the trigger cursor rather than substituting another target.

For webhooks, select the webhook trigger, save/synchronize, then create its credential. Core shows the credential once; rotation invalidates the previous value. POST JSON to the returned URL with `Authorization: Bearer <credential>` and a stable `Idempotency-Key`. Payloads are limited to 1 MB. Duplicate keys with identical payloads reuse the run; changed payloads fail. Disable the workflow or plugin to stop delivery.

A signal node declares its name and timeout. The run-history interface can queue that named signal or request cancellation. Core retains signal submissions until the selected runner has a matching wait, including signals received before it starts waiting. Native and server runners deliver through the same inbox and acknowledge delivery. Signal operation IDs are idempotent; a signal is not a permission grant.

The implementation uses the upstream [parallel step](https://openworkflow.dev/docs/parallel-steps), [dynamic step](https://openworkflow.dev/docs/dynamic-steps) and [signal](https://openworkflow.dev/docs/signals) primitives. SQLite tests cover the extended interpreter and signal recovery; `tests/integration/workflow-triggers.ts` covers PostgreSQL occurrence deduplication, authenticated webhooks, signal persistence and pinned publications.
