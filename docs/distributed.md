# Distributed core and recovery

## Ownership and storage

`packages/core` is portable TypeScript using WebCrypto and Automerge. Each workspace has separate signed membership history, encryption epochs, records, file manifests, events and settings. `packages/sync` carries bounded encrypted messages over libp2p WebSockets, Noise and Yamux, with WebRTC and circuit-relay transports for browsers. Direct connections and relayed connections use the same application authorization.

Browser replicas use a separate top-level Dexie database for each workspace and a separate device metadata database. Mobile replicas use Capacitor app-private files; the WebView’s Dexie database is a query/UI projection. Desktop replicas use atomic files, with identity keys protected by Electron safeStorage and an unlocked OS keyring. Headless replicas use restricted filesystem permissions and encrypted workspace journals. Protect the headless data directory and its backups as you would a device identity.

Core shares workspace control metadata and lets devices select which records and file versions to retain, including data for plugins they have not installed. Installing code is a separate, per-device decision. Files use immutable versions and SHA-256 addressed 256 KiB chunks. Missing chunks resume after reconnection. A save is acknowledged only after its local journal/chunks are committed; “saved locally” does not mean another device has a backup. Files currently have a 512 MiB limit.

The native PGlite database is an embedded compatibility projection for existing SQL-based plugins. It is not the replication authority and needs no PostgreSQL service. Workflow native checkpoints use OpenWorkflow’s local SQLite backend. Keep the complete native data directory together, including these checkpoints, when backing up an execution host.

## Merge and authorization

Each Automerge change is bound to its workspace, document, author and membership epoch by a signature. Dependencies cannot cross document boundaries. Independent record fields merge; conflicting writes to one field remain available in Settings. File branches remain immutable and can be downloaded separately. Deletion conflicts can be resolved explicitly.

An owner-signed policy chain admits editor or viewer device identities. Pairing requires an owner approval of the exact joining device keys. Invitations contain device-encrypted workspace keys. Revocation rotates future keys and fences the revoked device’s changes to exact hashes accepted by the owner. A revoked device can retain previously downloaded information; remote erasure is not promised. Back up the owner identity to retain membership administration after device loss.

The workspace is the privacy boundary. All approved devices can read its ordinary records. Use separate workspaces for private subsets. Credential metadata is shared, but secret material is separately encrypted to explicitly approved devices and mediated by plugin/destination grants. Changing a credential’s recipients requires setting its secret again. Previously disclosed secrets should also be rotated at their provider after revocation.

Known plugin schemas use the existing PostgreSQL field definitions and shared UI components. A record’s schema version travels with it. Unknown/newer plugin data can be retained without executing plugin code; editing requires a compatible installed schema. Never copy projections or modify the signed journal by hand.

## Commands and automation

JSON-RPC 2.0 commands and versioned CloudEvents are brokered by core. Replicating a record never invokes arbitrary native mutation hooks. Native execution requires an approved member, an enabled local capability, an installed provider and a selected device. Command operation IDs are durable and cannot be reused with different payloads. An interrupted operation with an unknown outcome is reported for review instead of being repeated.

Workflows pin their graph at publication. Browser/mobile and native use the same interpreter. Native OpenWorkflow checkpoints survive restart; the portable adapter stores encrypted local step checkpoints and resumes waits/signals while the app is active. Trusted TypeScript runs in a bounded native subprocess or a browser worker. These are trusted-author execution features, not hostile-code sandboxes. No Python runtime is used for automations.

A queued offline request is held on the requesting device until its selected peer is reachable, with an explicit deadline. Keep that app active for dispatch, or send while the target is online. Execution intents/checkpoints are device-local and cannot be created simply by replicating a `job/` document. External side effects cannot be made globally exactly-once by a CRDT; handlers must use operation IDs and report ambiguous provider outcomes.

Scheduled workflow triggers execute only on their declared target. Automations, individual accounts and other declared execution items each select a computer through [core execution](plugins/execution.md). Assignments are independent within a plugin and never fail over automatically. Browser/mobile availability is foreground availability; do not represent iOS suspension as a continuously running server.

## Workspace files

A [portable workspace archive or live folder](workspace-files.md) preserves shared records, files, connections and signed Automerge history while keeping the importing computer's identity and private settings separate. App-created files include a scoped connection credential for approving the importing device; older archives without this credential require an invitation from the owner. Device-scoped settings use encrypted local state, and exports omit the older replicated device-setting records.

## Backup and rollback

Settings exports complete `.taskasaur` workspace files with credentials included automatically and optional password encryption. These files can open on another installation without a new invitation; that installation keeps its own identity and Automerge actor. Older files without credentials still need owner approval on a new device. See [Workspace files](workspace-files.md) for live file editing, encryption and revocation.

Device-state recovery is separate from moving a workspace. Preserve a stopped native data directory if you need installed packages and workflow checkpoints. The app does not clone identities through a backup/restore screen. Query caches and plugin package caches remain local.

## Selected storage copies

All approved devices retain workspace discovery and authorization metadata. Individual record histories and immutable file versions can be placed on selected devices through core. New items default to all devices. Any editor can request placement for any approved device, with offline requests applied when it reconnects. Removing a copy requires another peer's live durable acknowledgement of the required Automerge history or verified file version; removing the last version is a separately confirmed operation. The same protocol serves browser/mobile and headless peers. See [storage placement](plugins/storage-placement.md) for the API, crash handling, version semantics and limits.
