# Portable workspace files

Settings → Workspace → **Export complete workspace** saves a `.taskasaur` ZIP archive containing the complete shared workspace. **Download all workspace content** first requests copies from connected peers. Export refuses known missing records, newer known Automerge heads, unfinished file uploads, missing chunks, or invalid history. An offline export contains everything known to this replica; no device can discover unseen edits from an offline peer.

The archive includes tables and column definitions, records, plugin settings shared through core, file contents and immutable versions, encrypted credential records, sharing policies, peer addresses, and original signed Automerge changes. Keeping the original changes preserves their hashes, dependencies, authors and merge history, so opening an older export can synchronize with newer peers.

Device signing/encryption keys, the current device identity, network private keys, local settings, folder paths and permissions, query/search indexes, UI caches, installed executable packages, native permissions, and execution checkpoints are excluded. Historical public device IDs remain in membership and signed history; they do not become the importing device's identity. Credential ciphertext is retained, but a new device still needs a credential grant before it can use a secret. Installing plugin code and enabling native execution remain separate local decisions.

## Open on another computer

1. On the welcome screen, select the archive or **Open workspace folder**.
2. For a new device, copy its request to the workspace owner's Devices page. Paste the returned invitation into **Workspace file approval**. An already approved device can open directly.
3. Open the workspace. The importing computer keeps its own identity. Saved peer addresses are restored, and available peers supply subsequent changes.

The owner may close after issuing approval; it does not need to stay online during import. This file is not a bearer credential: possession alone cannot approve a new computer, and the package does not contain the owner's private key. Prepare the invitation before taking the owner offline. The separate encrypted **device backup** flow includes an identity and is for recovering that same device, not moving a workspace to a new identity.

## Work directly from a folder

**Save and work from folder** creates the package layout below and switches shared writes to that directory. Changes are committed there before the app reports success; it is not a periodic export. The normal device store still holds identity, settings, execution state and caches. Reopening a remembered folder restores this routing. If file access has expired, the app requires reconnecting the folder instead of silently writing to an old local copy.

```text
My workspace/
  workspace.json       # Versioned manifest, peer links and membership history
  data/
    <sha256>.bin        # Encrypted, content-addressed changes and file chunks
```

An archive contains the same layout. Extract it into a folder to work directly from it. File contents are not embedded in table JSON or encoded as a bespoke office format. The existing Automerge journal and encrypted chunk store remain authoritative; adding a second SQLite/Turso database would duplicate that authority.

The portable `WorkspaceStorage` adapter uses a `WorkspaceFiles` interface (`read`, atomic `write`, `remove`). `WorkspaceRouter` directs shared keys to the mounted adapter and keeps private keys local. Browser directories use File System Access handles, remembered in a local Dexie database. Electron uses a narrowly scoped native directory picker and filesystem adapter; headless peers use that same native adapter. Native writes use fsync and atomic replacement, with a directory writer lock. Referenced bytes are durable before the manifest changes. Removed unreferenced blobs are released after that commit.

Use one active writer per folder. Native processes enforce a writer lock; manifest revisions also detect outside edits. Do not concurrently edit one directory through different applications or cloud-drive mounts. Give each running device its own directory and use Taskasaur peer synchronization between them. This preserves each Automerge actor and avoids conflicting filesystem writers.

Direct directory access appears only where supported. Other browsers and mobile WebViews keep using their normal local storage and can import/export archives. Archive import is capped at 1 GB and verifies paths, sizes, SHA-256 hashes, membership signatures and Automerge dependencies before accepting application writes. Import/export currently stages a snapshot in memory; available device memory also limits package size. Normal mounted-folder updates write incremental chunks and changes.

## Headless use

```sh
# Run from an existing folder after approving this device through the normal pairing flow.
npm run peer -- --data ./device-state --workspace-folder ./My-workspace --no-ui

# With the peer stopped, export either its local store or the selected live folder.
npm run peer -- --data ./device-state --workspace-id WORKSPACE_ID --export-workspace ./workspace.taskasaur
npm run peer -- --data ./device-state --workspace-folder ./My-workspace --export-workspace ./workspace.taskasaur

# Import into this device; provide its owner-issued invitation if it is new.
npm run peer -- --data ./device-state --import-workspace ./workspace.taskasaur --join ./invitation.json
```

`TASKASAUR_WORKSPACE_FOLDER` also selects the live directory. With Docker, mount that directory separately and set this variable to its container path. Keep `/data` persistent for this computer's identity and local execution state. An export never replaces that device directory, and an existing output archive is not overwritten by the CLI.
