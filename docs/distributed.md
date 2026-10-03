# Distributed core and recovery

## Ownership and storage

`packages/core` is portable TypeScript using WebCrypto and Automerge. Each workspace has separate signed membership history, encryption epochs, records, file manifests, events and settings. `packages/sync` carries bounded encrypted messages over libp2p WebSockets, Noise and Yamux, with WebRTC and circuit-relay transports for browsers. Direct connections and relayed connections use the same application authorization.

Browser replicas use a dedicated Dexie database. Mobile replicas use Capacitor app-private files; the WebView’s Dexie database is a query/UI projection. Desktop replicas use atomic files, with identity keys protected by Electron safeStorage and an unlocked OS keyring. Headless replicas use restricted filesystem permissions and encrypted workspace journals. Protect the headless data directory and its backups as you would a device identity.

Every approved device receives the entire workspace journal and all referenced file chunks, even for plugins it has not installed. Installing code is a separate, per-device decision. Files use immutable versions and SHA-256 addressed 256 KiB chunks. Missing chunks resume after reconnection. A save is acknowledged only after its local journal/chunks are committed; “saved locally” does not mean another device has a backup. Files currently have a 512 MiB limit.

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

## Backup and rollback

Devices offers a passphrase-encrypted backup of the portable device store, including its signing/encryption identity, membership, local execution checkpoints, records and downloaded file chunks. The backup uses PBKDF2-SHA256 (600,000 iterations) and AES-GCM. Keep the passphrase separately. Verify file-download completion before treating it as a full workspace backup.

Restore into an empty profile using the welcome screen. Retire the old copy of that device identity first: two active writers must never use the same Automerge actor identity. Use pairing, rather than backup cloning, to add another device. Native directory backups must include workflow SQLite files and installed plugin state in addition to the portable store. Browser UI package caches are per-device and may need installation again after recovery.

The local process lock and browser Web Lock prevent two writers opening one profile. Stop a native peer before CLI management/import/restore operations. Different devices must use different data directories. Never mount one native directory in two active containers.

The former application’s downloaded Dexie records and local file versions are imported once into a replica, preserving the original database for rollback. Data that existed only in the old server is not inferred from a frontend cache. Export it from that installation before retiring it; the old server repository and volumes remain untouched.

Mobile writes use a small native atomic-storage bridge (Swift on iOS and Java on Android); all replication and automation logic remains TypeScript. Android uses `AtomicFile` with fsync; iOS uses atomic replacement, fsync and app-private file protection. The iOS minimum is 16.4. Automatic OS identity cloning is excluded; use device pairing or the explicit encrypted recovery flow.

The ordinary device presence handshake is ephemeral. Durable device records change when the name or capabilities change, avoiding an ever-growing heartbeat journal. Use `core.peers` for current online state. OAuth refresh runs on the credential issuer, is serialized per credential, requires the exact authorized HTTPS token endpoint and preserves the approved recipient list. Other devices need that issuer online when its token expires.
