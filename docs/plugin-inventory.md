# Plugin inventory

Optional plugins remain independent `taskasaur-plugin-<id>` repositories. Devices consume the public [inventory](https://github.com/taskasaur/taskasaur-plugin-inventory/blob/main/plugins.json); every entry names an HTTPS download URL, checksum, publisher and permissions. Any HTTPS host can distribute a signed archive.

The current distributed [plugin specification](plugins/README.md) lives in this repository alongside `packages/platform`, the authoritative SDK. The inventory repository's original specification describes the v1 compatibility contract. New plugins should supply a portable `entrypoints.core` module and opt into platform capabilities explicitly.

Set `PLUGIN_INVENTORY_URL` for native peers or build-time `VITE_PLUGIN_INVENTORY_URL` for the UI. Installs verify signatures and checksums and retain downloaded code locally for offline use. A workspace replicates plugin records without requiring every device to install executable code. Review and install code independently on each execution device.

Native packages are stored under `<data>/plugins`; browser packages are in the device's local cache. Container updates preserve the `/data` volume. Use `npm run peer -- --data <directory> --plugin <id> --workspace-id <id>` with that peer stopped, or use an item’s **Execution settings** to install reviewed dependencies on its selected online computer. Enable remote installation locally in Devices. See [per-item execution](plugins/execution.md) for status, grants and signed handoff.

Native plugin code is trusted in-process code. Back up the entire native data directory, including plugin packages, local workflow checkpoints and projections. Workspace files retain shared data while keeping installation identities separate; reinstall reviewed UI packages on a new device.
