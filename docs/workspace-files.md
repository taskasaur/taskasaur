# Portable workspace files

Settings → Workspace → **Export complete workspace** saves a `.taskasaur` ZIP archive containing the complete shared workspace. **Download all workspace content** first requests copies from connected peers. Export refuses known missing records, newer known Automerge heads, unfinished file uploads, missing chunks, or invalid history. An offline export contains everything known to this replica; no device can discover unseen edits from an offline peer.

The archive includes tables and column definitions, records, plugin settings shared through core, file contents and immutable versions, encrypted credential records, sharing policies, peer addresses, and original signed Automerge changes. Keeping the original changes preserves their hashes, dependencies, authors and merge history, so opening an older export can synchronize with newer peers.

Device signing/encryption keys, the current device identity, network private keys, local settings, file paths and permissions, query/search indexes, UI caches, installed executable packages, native permissions, and execution checkpoints are excluded. Historical public device IDs remain in membership and signed history; they do not become the importing device's identity. Installing plugin code and enabling native execution remain separate local decisions.

## Create, join and open

The welcome screen has three choices:

- **Create**: name an internal workspace and use the connected arrow button, or choose **Create file workspace** and select a new `.taskasaur` file. Browsers without direct file access download the file and open an internal working copy; export subsequent changes from Settings.
- **Join**: use the attached copy button to send the single-line **Device request** to the owner and paste the returned **Workspace invitation**.
- **Open**: choose an internal workspace from the dropdown, or use **Open file workspace**. Where direct file access is unavailable, the file picker imports an internal copy.

Each browser workspace has a separate top-level IndexedDB database (`taskasaur-peer-v1.workspace.<workspace-id>`), plus its own query/UI projection. Existing prefixed storage is migrated only when that workspace is opened. Startup reopens only the selected workspace. **Switch workspace** closes its plugin runtime, storage handles and peer handler, then returns to the welcome screen. Desktop services also deactivate that workspace; headless peers continue to serve their configured workspaces. Opening a different workspace does not read another workspace's file contents.

## Encryption and credentials

**Encrypt workspace file** is optional. When selected, an eight-character minimum password encrypts the entire archive, including metadata and any exported credentials, with PBKDF2-SHA256 (600,000 iterations) and AES-256-GCM. Live saves remain encrypted. Passwords stay in memory while a file is open; they are not stored in profiles, caches or the workspace. Closing the workspace clears the adapter's password. Reopening an encrypted file asks for it again.

Files created or exported from the app automatically include access to plugin secrets owned by this workspace user and a workspace-scoped connection credential, so another device can open the file and reconnect to its saved peers without another invitation. No separate credential switch or plugin installation is needed: Credentials is a required core service. Encryption remains optional. Anyone able to open a file can exercise its included access. Older files without a connection credential still require owner approval on a new device.

The owner creates the first portable connection credential. It is an editor member named **Workspace file access**, never a copy of the owner's private identity. An importing installation keeps its existing physical identity and independent Automerge actor. The portable credential signs a public, workspace-scoped grant to that device; core transmits these grants with peer messages. Recipients validate signatures, user, role and workspace scope against the owner-signed membership history. Plugin permissions and allowed credential destinations still apply. All participating peers must support these connection grants. An imported device with this credential retains it when saving or exporting again. New and rotated secrets automatically include active portable grants for the same credential owner, so a live workspace file keeps access without being exported again. Revoked grants and grants belonging to a different user are excluded.

In **Devices**, the owner can revoke **Workspace file access** to revoke its derived devices together. Revocation fences accepted history and rotates the workspace key. An offline exported copy remains readable; revoked access is rejected when communicating with updated peers. Files without credentials still open directly on a device already approved for that workspace. Saved peer addresses are restored, and available peers supply subsequent changes using the original Automerge history.

There is one workspace file flow for plain and encrypted files. It does not restore or clone device identities, and does not require retiring the original computer.

## Work directly from a single file

In Settings → Workspace, choose **Save and work from file** and select a new `.taskasaur` filename. Shared changes then go directly into that file before a save is acknowledged. On the welcome screen, **Open → Open file workspace** opens an existing export for live editing without conversion. The selected file reopens when permission is still available, prompting for its password if encrypted; otherwise reconnect the file. Other saved files stay closed. Device identity, permissions, caches and execution state remain in the device's own store.

The live file uses the same ZIP layout as an exported archive, including all original signed Automerge changes and encrypted file chunks. `ArchiveWorkspaceFiles` implements the existing storage interface with an atomic `commit(manifest, additions)` operation. New bytes and their manifest become visible together. Unreferenced bytes are removed in that same replacement. A write failure before replacement leaves the previous committed file intact. If durability cannot be confirmed, the app reports an error rather than acknowledging the save. No separate database or conversion is required.

Electron and headless peers write a temporary file, flush it, atomically replace the original, then flush its directory where supported. A temporary `.lock` sidecar prevents another native writer and is removed on close; it contains no workspace data and is not needed to move the file. Browser file access uses the platform's writable-file API, committing only after the stream closes, with a Web Lock to prevent duplicate writers in the same browser origin. Both adapters check the previous file's hash before replacing it and refuse unexpected external changes. This is a single-writer file: close it before moving it or opening it in another application/device. Running devices should use separate copies and peer synchronization, rather than sharing one file through a cloud-drive mount.

Live writes currently replace the whole ZIP, so write time and temporary memory/disk use grow with workspace size. The 1 GB archive limit applies, and available memory may impose a smaller practical limit. The directory adapter remains available for larger, frequently modified workspaces because it can write individual chunks. The app waits for completion in either mode; this is not a delayed export that can silently lose the latest edits.

Direct file editing is available in Electron, headless mode, and browsers with the read/write [File System Access API](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access). Pickers are capability-detected. Other browsers and mobile WebViews use local storage with archive import/export. Browser-granted file permissions and handles stay local and never enter the workspace file.

## Package layout and adapters

Plain files are ZIP containers with `workspace.json` and `data/<sha256>.bin` entries. Encrypted files wrap the same archive in a versioned authenticated envelope. File contents remain immutable encrypted chunks, not table JSON or a bespoke office format. The Automerge journal remains authoritative.

`WorkspaceStorage` uses `WorkspaceFiles` (`read`, atomic `write`, `remove`, and optional atomic package `commit`). `WorkspaceRouter` routes shared keys to the mounted adapter while keeping private keys local. Existing folder bindings remain compatible; the directory adapter is available to headless deployments through `--workspace-folder`. The app's Create/Open flow uses `.taskasaur` files.

Archive import is capped at 1 GB and verifies paths, sizes, hashes, membership signatures, connection grants and Automerge dependencies before accepting application writes. Import/export stages a snapshot in memory; available memory may impose a lower limit.

## Headless use

```sh
# Run directly from a .taskasaur file with included credentials or an approved device.
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

Use `--include-credentials` with `--export-workspace` to include portable access explicitly. Add `--passphrase-file <private-file>` to encrypt exports or unlock imports/live files; this is optional even when including credentials. `TASKASAUR_WORKSPACE_PASSWORD_FILE` accepts the same secret-file path for a running peer. In Compose, mount the password file as a secret and set that path. Protect the device-state directory separately; workspace exports intentionally exclude native execution state and installed packages.
