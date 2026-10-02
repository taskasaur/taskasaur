# Taskasaur client

Taskasaur's shared React interface for web, Electron desktop and Capacitor mobile. This repository contains the UI, local Dexie storage, offline shell, browser plugin host and native device adapter. The API, workers, credentials, PostgreSQL/Supabase deployment and plugin SDK source live in [taskasaur-server](https://github.com/taskasaur/taskasaur-server).

## Develop

Use Node.js 24.

```sh
npm ci
npm run dev
```

Open `http://localhost:5173`. Local workspaces work without a server. To connect, run the server repository's Docker stack on port 3000; Vite forwards `/api`, `/auth/v1` and `/device-stream` to it. `TASKASAUR_API_PROXY_URL` changes this development proxy. The connect form also accepts a remote server URL.

## Build

```sh
npm run build        # Static web client in dist/
npm run start        # Preview on port 4173
npm run build:desktop
npm run prepare:ios
npm run prepare:android
```

Native packaging still requires the platform SDKs. Office engine assets are prepared separately; see [office engine status](docs/office-engine.md).

```sh
docker compose up -d --build
```

The client container serves port 8080 and forwards API calls to `TASKASAUR_SERVER_URL` (default `http://host.docker.internal:3000`). It contains static files and Nginx. The server's allowed origins must include the client URL. Neither server credentials nor database files belong in this repository.

## Validate

```sh
npm run sdk:verify
npm run typecheck
npm test
npm run build:web
```

See [repository separation](docs/repository-separation.md) for ownership, SDK updates and existing installation migration. See [plugin interface](docs/plugins/README.md) for plugin development.

See [downloadable plugins](docs/plugin-inventory.md) for independent plugin repositories, inventory configuration and the authoring specification.
