# Storage placement

Core owns replication and retention for every plugin. A plugin never opens another device's database or runs storage commands from a received record. The same controls apply to browser, mobile, desktop and headless peers.

## Opt in to programmatic placement

Declare the optional service in `sharedServices` and permission in `permissions`, then obtain it through the host:

```json
{
  "sharedServices": [
    { "id": "core.storage.placement", "version": "^1", "optional": true }
  ],
  "permissions": ["core.storage.placement"]
}
```

```ts
import type { StoragePlacementService } from "@taskasaur/platform/plugin-sdk/storage-placement";

const placement = context.services.optional<StoragePlacementService>(
  "core.storage.placement",
);
if (placement) {
  // recordId belongs to this plugin; targetDeviceId is an approved device identity.
  // The copy stays on its source until a live peer acknowledges the required history.
  await placement.setCopy(
    { kind: "record", id: recordId },
    targetDeviceId,
    true,
  );
  const status = await placement.status({ kind: "record", id: recordId });
  // Show status.copies: requested and retained are deliberately distinct.
}
```

`list()` returns the plugin's own records and versions of files it manages. `status(item)` and `setCopy(item, deviceId, keep)` enforce the same ownership scope in browser and native hosts. Core managed resources use `managedBy` as ownership; ordinary records use their collection's `pluginId`. Cross-plugin access continues through declared messages. Use the existing `core.peers` service to discover approved devices and their capabilities; IDs here are device identity IDs, not `devices` record UUIDs.

All records are retained everywhere by default. Set the destination to `true` before requesting `false` on the source. A request is durable workspace metadata and can be authored by any editor for any approved device. Viewers can see placement but cannot change it. Offline destinations remain pending. Opting out stops new payload downloads; routing metadata is still replicated. Placement is not an access-control boundary between approved workspace members.

The shared `RecordTable` supplies a **Storage copies** action. The core **Settings → Storage copies** page lists remote-only items and every immutable file version, so users can restore an item locally even after its plugin table no longer contains it. Plugins do not need to build their own device switches. File storage metadata, table definitions, device records and credential authorization metadata always replicate. Published workflow definitions, execution journals and other core coordination documents also remain replicated; this API selects record histories and file payloads, not runtime control state. Native execution checkpoints and backups have their own lifecycle. Credential secret distribution still requires explicit recipient grants.

Programmatic placement has no destructive deletion method. The core UI separately asks the user to review and confirm **Delete this version everywhere**, bound to a version token. Turning off all requested copies leaves the last available copy pending. A stale confirmation fails and must be reviewed again. An ordinary plugin record delete remains its existing soft-delete operation; it does not silently purge history.

## Version and handoff contract

- Record versions are Automerge heads, not modification timestamps or SQL revision numbers. The signed history stays with the document.
- File versions are immutable manifests and SHA-256-verified content; their chunks can be deduplicated across versions.
- Handoff requires an authenticated live `storage-retain` response from another approved peer that has durably saved the reviewed heads (or later heads including that history), or the complete file bytes. A replicated receipt alone cannot authorize removal.
- A receiving device only acknowledges retention while its own desired copy is on. Simultaneous requests to remove all copies therefore leave data pending instead of authorizing each other to remove it.
- Durable release markers precede journal/chunk cleanup. They prevent interrupted cleanup from resurrecting partial records after restart. Shared chunks are released only when every referring version has been released.
- Core removes the local record/file projection and search cache after release. The small label, ownership, heads and placement catalog remains available for discovery on all peers. Local UI preferences and search indexes never become the synchronization source.

Automerge supplies CRDT history, merging, heads and compressed save/load. It does **not** supply placement approval or last-copy guarantees: those are core responsibilities in the existing signed libp2p protocol. The storage-only server avoids the SQL projection and execution engines, coalesces sync ticks and compresses inactive Automerge documents in memory. This is not a hard process-memory limit; the signed journal and control metadata remain indexed.

Deletion removes a complete record at the reviewed heads, including its history, or one immutable file version. Automerge cannot remove one historical revision while preserving later revisions that depend on it. A disconnected device with different heads keeps its edits; deleting those requires a fresh review. Historical content can also remain in another retained descendant, export or backup. Deletion is not cryptographic erasure, and a live handoff cannot guarantee survival of subsequent hardware loss. Keep an independent backup for disaster recovery.
