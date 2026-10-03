# Repository ownership after the distributed migration

`taskasaur` now contains the portable core, replication, shared UI, Electron/Capacitor adapters, native/headless capabilities, deployment and `packages/platform` SDK source. Its npm workspace replaces the old vendored SDK archive. Build SDK outputs with `npm run sdk:build`; generated `dist` files are not committed.

`taskasaur-server` is the preserved historical installation. It is not imported at runtime, required by the build, modified or deleted by this migration. Existing deployments and their volumes can be kept for rollback/export. Never point the new peer at an old server data volume.

`taskasaur-plugin-inventory` continues to publish a signed-artifact catalog. Optional plugin repositories continue to own their packages. Hosts support existing v1 packages through compatibility adapters; new portable modules should use the documented core entrypoint and services. Changes here do not automatically publish new packages or rewrite another repository.

The prior frontend baseline is commit `4159a2e`. The new commits preserve that history. Plan/status documents remain outside the implementation commits as requested.
