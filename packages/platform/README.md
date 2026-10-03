# Taskasaur platform SDK

The SDK source is maintained in the main Taskasaur repository. Build it with `npm run sdk:build` from the repository root. Feature plugins remain separate packages.

Read the [distributed plugin specification](../../docs/plugins/README.md) for mandatory PostgreSQL field contracts, shared UI/storage, JSON-RPC and CloudEvents messaging, declared capabilities, credential use, signing and inventory metadata. Portable modules use `entrypoints.core`; browser surfaces and native services are optional adapters.

SDK 0.4 removes the retired central-server device host exports. Native terminal and automation execution now belong to the app's device adapters. The v1 record/UI and native plugin compatibility contracts remain supported.
