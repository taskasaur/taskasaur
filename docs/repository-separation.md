# Client/server repository separation

| Owner                        | Contents                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taskasaur`                  | React/shared UI, field components, Dexie, synchronization client, browser plugin host, PWA, Electron, Capacitor, static client container                                    |
| `taskasaur-server`           | HTTP API, authentication, PostgreSQL, credential/file/mail services, plugin installation and server host, workers, automation dispatch, device gateway, Supabase deployment |
| Server's `packages/platform` | Versioned `@taskasaur/platform` contracts, fields, core plugin catalog, messaging and portable TypeScript automation/device runtime                                         |

The client consumes a pinned npm archive under `vendor/`, never a sibling source path. Browser imports contain only shared contracts/core. Electron and the optional device CLI consume the SDK's Node device runtime so this computer can host terminals and execute automations. They do not embed the server, Supabase or credential database. Backend-only modules are not SDK exports.

## Independent setup

Start the server following its README, then `npm ci && npm run dev` here. The client defaults to its same-origin API proxy. Set `TASKASAUR_API_PROXY_URL` for Vite dev/preview, or `TASKASAUR_SERVER_URL` for the static Docker proxy. For a direct connection, enter the server URL in the UI or set public build-time `VITE_SERVER_URL`. Allow the client origin on the server. Separate origins on the same site use credentialed CORS; genuinely cross-site deployment requires HTTPS and server `COOKIE_SAME_SITE=none`, subject to browser third-party-cookie policies. A same-origin proxy avoids that browser limitation.

All `VITE_*` settings become public browser code. Server database passwords, encryption keys and service-role credentials must never use that prefix. An existing ignored `.env` from the former monorepo is left in place by this migration and is not built into the client. New installs use the server's setup command.

## Update the SDK

From a server checkout, edit `packages/platform/src`, test the server, then:

```sh
npm run sdk:pack -- --out ../taskasaur/vendor
```

For a new version, update `packages/platform/package.json`, the server workspace dependency and the client's archive dependency together. In the client run `npm install`, `npm run sdk:verify`, `npm run typecheck`, `npm test` and both relevant builds. Commit the archive, checksum manifest, package file and lockfile. The archive permits a frontend checkout to build without a server checkout or private registry. Source ownership and source/artifact checksums are recorded in `vendor/platform-source.json`. API/schema compatibility is explicit in plugin manifests and core release metadata; the server remains authoritative.

## Existing installations

Backend Docker deployment now runs from `taskasaur-server`. Preserve the old Compose project name and environment file; do not recreate secrets or delete volumes. The server migration guide shows `--env-file ../taskasaur/.env` so private configuration can stay where it is. Database, file and installed-plugin volumes are retained by project name. Office assets remain on the frontend and are mounted into its static container or packaged with the native client. The server and client now build and release separate images; each has its own CI workflow.
