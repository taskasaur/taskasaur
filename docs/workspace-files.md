# Portable workspace files

Settings → Workspace → **Export complete workspace** saves a `.taskasaur` ZIP archive containing the complete shared workspace. **Download all workspace content** first requests copies from connected peers. Export refuses known missing records, newer known Automerge heads, unfinished file uploads, missing chunks, or invalid history. An offline export contains everything known to this replica; no device can discover unseen edits from an offline peer.

The archive includes tables and column definitions, records, plugin settings shared through core, file contents and immutable versions, encrypted credential records, sharing policies, peer addresses, and original signed Automerge changes. Keeping the original changes preserves their hashes, dependencies, authors and merge history, so opening an older export can synchronize with newer peers.

Device signing/encryption keys, the current device identity, network private keys, local settings, folder paths and permissions, query/search indexes, UI caches, installed executable packages, native permissions, and execution checkpoints are excluded. Historical public device IDs remain in membership and signed history; they do not become the importing device's identity. Credential ciphertext is retained, but a new device still needs a credential grant before it can use a secret. Installing plugin code and enabling native execution remain separate local decisions.

## Open on another computer

1. On the welcome screen, choose **Open workspace file** to work directly from a `.taskasaur` file. The archive input imports a separate local copy. Existing folders can still be opened.
2. For a new device, copy its request to the workspace owner's Devices page. Paste the returned invitation into **Workspace file approval**. An already approved device can open directly.
3. Open the workspace. The importing computer keeps its own identity. Saved peer addresses are restored, and available peers supply subsequent changes.

The owner may close after issuing approval; it does not need to stay online during import. This file is not a bearer credential: possession alone cannot approve a new computer, and the package does not contain the owner's private key. Prepare the invitation before taking the owner offline. The separate encrypted **device backup** flow includes an identity and is for recovering that same device, not moving a workspace to a new identity.

## Work directly from a single file

In Settings → Workspace, choose **Save and work from file** and select a new `.taskasaur` filename. Shared changes then go directly into that file before a save is acknowledged. On the welcome screen, **Open workspace file** opens an existing export for live editing without conversion. Remembered files reopen automatically when permission is still available; otherwise reconnect the file. Device identity, permissions, caches and execution state remain in the device's own store.

The live file uses the same ZIP layout as an exported archive, including all original signed Automerge changes and encrypted file chunks. `ArchiveWorkspaceFiles` implements the existing storage interface with an atomic `commit(manifest, additions)` operation. New bytes and their manifest become visible together. Unreferenced bytes are removed in that same replacement. A write failure before replacement leaves the previous committed file intact. If durability cannot be confirmed, the app reports an error rather than acknowledging the save. No separate database or conversion is required.

Electron and headless peers write a temporary file, flush it, atomically replace the original, then flush its directory where supported. A temporary `.lock` sidecar prevents another native writer and is removed on close; it contains no workspace data and is not needed to move the file. Browser file access uses the platform's writable-file API, committing only after the stream closes, with a Web Lock to prevent duplicate writers in the same browser origin. Both adapters check the previous file's hash before replacing it and refuse unexpected external changes. This is a single-writer file: close it before moving it or opening it in another application/device. Running devices should use separate copies and peer synchronization, rather than sharing one file through a cloud-drive mount.

Live writes currently replace the whole ZIP, so write time and temporary memory/disk use grow with workspace size. The 1 GB archive limit applies, and available memory may impose a smaller practical limit. The directory adapter remains available for larger, frequently modified workspaces because it can write individual chunks. The app waits for completion in either mode; this is not a delayed export that can silently lose the latest edits.

Direct file editing is available in Electron, headless mode, and browsers with the read/write [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access). Pickers are capability-detected. Other browsers and mobile WebViews use local storage with archive import/export. Browser-granted file permissions and handles stay local and never enter the workspace file.

## Work directly from a folder

**Save and work from folder** creates the package layout below and switches shared writes to that directory. Changes are committed there before the app reports success; it is not a periodic export. The normal device store still holds identity, settings, execution state and caches. Reopening a remembered folder restores this routing. If file access has expired, the app requires reconnecting the folder instead of silently writing to an old local copy.

```text
My workspace/
  workspace.json       # Versioned manifest, peer links and membership history
  data/
    <sha256>.bin        # Encrypted, content-addressed changes and file chunks
```

An archive contains the same layout. Extract it into a folder to work directly from it. File contents are not embedded in table JSON or encoded as a bespoke office format. The existing Automerge journal and encrypted chunk store remain authoritative; adding a second SQLite/Turso database would duplicate that authority.

The portable `WorkspaceStorage` adapter uses a `WorkspaceFiles` interface (`read`, atomic `write`, `remove`, and optional atomic package `commit`). `WorkspaceRouter` directs shared keys to the mounted adapter and keeps private keys local. Browser directories use File System Access handles, remembered in a local Dexie database. Electron uses a narrowly scoped native directory picker and filesystem adapter; headless peers use that same native adapter. Native writes use fsync and atomic replacement, with a directory writer lock. Referenced bytes are durable before the manifest changes. Removed unreferenced blobs are released after that commit.

Use one active writer per folder. Native processes enforce a writer lock; manifest revisions also detect outside edits. Do not concurrently edit one directory through different applications or cloud-drive mounts. Give each running device its own directory and use Taskasaur peer synchronization between them. This preserves each Automerge actor and avoids conflicting filesystem writers.

Direct directory access appears only where supported. Other browsers and mobile WebViews keep using their normal local storage and can import/export archives. Archive import is capped at 1 GB and verifies paths, sizes, SHA-256 hashes, membership signatures and Automerge dependencies before accepting application writes. Import/export currently stages a snapshot in memory; available device memory also limits package size. Normal mounted-folder updates write incremental chunks and changes.

## Headless use

```sh
# Run directly from a .taskasaur file after approving this device.
npm run peer -- --data ./device-state --workspace-file ./workspace.taskasaur --no-ui

# Export the current complete workspace, then use that file as the live store.
npm run peer -- --data ./device-state --workspace-id WORKSPACE_ID --export-workspace ./workspace.taskasaur

# Run from an existing folder after approving this device through the normal pairing flow.
npm run peer -- --data ./device-state --workspace-folder ./My-workspace --no-ui

# With the peer stopped, export either its local store or the selected live folder.
npm run peer -- --data ./device-state --workspace-id WORKSPACE_ID --export-workspace ./workspace.taskasaur
npm run peer -- --data ./device-state --workspace-folder ./My-workspace --export-workspace ./workspace.taskasaur

# Import into this device; provide its owner-issued invitation if it is new.
npm run peer -- --data ./device-state --import-workspace ./workspace.taskasaur --join ./invitation.json
```

`TASKASAUR_WORKSPACE_FILE` selects a live file; `TASKASAUR_WORKSPACE_FOLDER` selects a live directory. Set only one. For Docker file mode, mount the enclosing directory and set the file path inside it (for example, mount `./workspaces:/workspaces` and set `TASKASAUR_WORKSPACE_FILE=/workspaces/home.taskasaur`). Do not bind-mount the file itself: atomic replacement needs to rename a sibling temporary file over it. With Docker, mount that directory separately and set this variable to its container path. Keep `/data` persistent for this computer's identity and local execution state. An export never replaces that device directory, and an existing output archive is not overwritten by the CLI.
