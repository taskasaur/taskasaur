# Taskasaur

Taskasaur is being rebuilt as a local-first TypeScript workspace with one shared React interface for web/PWA, Electron and Capacitor. Records use PostgreSQL field definitions, shared form/table controls and a per-account Dexie outbox. Twelve required core providers supply storage, credentials, authorization, devices and communication to installable feature plugins.

The working implementation includes tasks, Track/time/focus, calendar/reminders, email, visual TypeScript automation, remote terminals, shared files and an offline office integration. The full rebuild is still in progress; office presentation/mobile support and other platform acceptance gates remain unfinished. See the local implementation ledger for current verification.

## Run locally

Use Node.js 24 and npm. Local-only workspaces can run without a server:

```sh
npm ci
npm run dev
```

For the connected app, install Docker with Compose v2 and run:

```sh
npm run setup
docker compose build app
docker compose up -d
```

Open `http://localhost:3000`. Setup creates private installation secrets and never rotates existing secrets when adding missing settings. The deployment starts from the **unmodified official Supabase Docker release**, recorded in [UPSTREAM.json](deploy/supabase/UPSTREAM.json). [Self-hosting](docs/self-hosting.md) explains the overlay, ports, persistent data, development setup and upgrades.

## Develop and verify

```sh
npm run typecheck
npm test
npm run compose:verify
npm run build:web
npm run build:desktop
```

`npm run dev:native` runs the shared client with Vite. `npm run electron:dev` starts Electron; `npm run prepare:ios` and `npm run prepare:android` sync the shared client into the native projects. Packaging a shell does not establish that every native integration has passed its platform tests.

## Code and interfaces

- `app`: Next.js host and authenticated API routes.
- `packages/app-ui`, `packages/ui`: shared views and locally maintained shadcn primitives.
- `packages/core`, `packages/plugin-sdk`, `plugins/core`: required providers and plugin contracts.
- `packages/field-types`, `packages/data-dexie`, `packages/sync-supabase`: typed values, local persistence and synchronization.
- `server`: PostgreSQL repositories, credential/file brokers, jobs, plugin hosts and device runners.
- `electron`, `ios`, `android`: native hosts for the shared interface.
- `deploy`: official Supabase sources, Taskasaur overlay and image builds.
- `tests`: unit, PostgreSQL/protocol integration and browser acceptance checks.

The [plugin interface](docs/plugins/README.md), [automation guide](docs/plugins/automation.md), [terminal guide](docs/plugins/remote-terminal.md) and [office engine guide](docs/office-engine.md) describe the integration boundaries. Legacy Markdown/CSDB application code has been replaced; historical data and starter files are retained for migration work.

Releases are created with `make release version=X.Y.Z` from a clean, synchronized branch. That command commits version metadata, tags and pushes; it is an explicit publishing operation. This checkout has not been published.
