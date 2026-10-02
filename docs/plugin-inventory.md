# Downloadable plugins

Optional plugins live in independent `taskasaur-plugin-<id>` repositories. The server and client consume the public [inventory](https://github.com/taskasaur/taskasaur-plugin-inventory/blob/main/plugins.json), not a hardcoded list of feature implementations.

The canonical [plugin specification](https://github.com/taskasaur/taskasaur-plugin-inventory/blob/main/docs/plugin-specification.md) covers manifests, PostgreSQL field contracts, shared UI and Dexie interfaces, core messaging/credentials/devices, server hooks, building/signing, and adding a download URL to the catalog.

Set server `PLUGIN_INVENTORY_URL` or client build-time `VITE_PLUGIN_INVENTORY_URL` to use another HTTPS JSON catalog. Downloads can be hosted anywhere; no GitHub API is used. The app reviews metadata and grants, installs dependencies, verifies the artifact checksum and publisher signature, then enables the plugin. Optional feature flags remain off. Existing records and collection IDs are preserved, and downloaded browser modules remain cached for offline use. Core boots without optional downloads.

Server installations live on the persistent `plugin-data` volume; pulling a new server image retains them. Server plugin code is trusted in-process code and updates apply across workspaces. Back up plugin volume and database together. If upgrading a workspace with former built-ins, install the corresponding signed package from Plugins; existing data is reused. Operators can preinstall using `npm run plugins -- inventory` and `npm run plugins -- install-id <id> <reviewed-grants...>` from the server repository.

For a custom inventory in a frontend Docker build, pass `--build-arg VITE_PLUGIN_INVENTORY_URL=https://your-host/plugins.json`. Connected workspaces use their server's inventory setting.
