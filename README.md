<p align="center">
  <img src="public/taskasaur_icon.png" width="112" height="112" alt="Taskasaur logo" />
</p>

<h1 align="center">Taskasaur</h1>

<p align="center">
  <a href="https://github.com/taskasaur/taskasaur/actions/workflows/container.yml"><img src="https://github.com/taskasaur/taskasaur/actions/workflows/container.yml/badge.svg?branch=main" alt="Container build and tests" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-GPL--3.0-blue" alt="GPL 3.0 license" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-26.10%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 26.10 or later" /></a>
  <a href="https://github.com/taskasaur/taskasaur/pkgs/container/taskasaur"><img src="https://img.shields.io/badge/container-amd64%20%7C%20arm64-2496ED?logo=docker&logoColor=white" alt="Docker: amd64 and arm64" /></a>
  <a href="docs/distributed.md"><img src="https://img.shields.io/badge/local_first-Automerge-7252D3" alt="Local-first with Automerge" /></a>
</p>

A TypeScript workspace with independent devices and durable copies wherever you choose to keep them. React provides the same interface in the browser, Electron and Capacitor. Devices exchange signed Automerge changes and encrypted file chunks through libp2p. No central application server, hosted account or external database is required.

This repository owns the shared core, UI, platform adapters, headless peer and plugin SDK. The previous server repository is not used or modified. Optional plugins remain independent, signed packages discovered through a configurable JSON inventory.

## Run

Use Node.js 26.10 or later (`nvm install && nvm use`). The container and CI pin 26.10.0 to avoid a [Node 24 WebAssembly runtime crash](https://github.com/nodejs/node/issues/66366). CloudEvents 10 currently emits an engine warning because its declared range stops at Node 24; its messaging integration is tested on Node 26.

```sh
npm ci
npm run dev                       # http://localhost:5173
npm run build
npm run peer -- --workspace Home  # http://127.0.0.1:8080; peer port 8787
npm run electron:dev
```

Create a workspace on the first device. On another device, choose **Join workspace**, copy its device request, and approve it in the first device’s **Devices** page. Return the encrypted invitation to the joining device. Add a reachable peer address and synchronize. The invitation is bound to that device’s public keys.

A browser cannot accept an ordinary TCP listener. Connect it to a reachable native/headless peer or libp2p relay; WebRTC and relay transport are available. Internet browser connections need HTTPS/WSS. No public relay is silently selected. Approved peers keep their own selected copies; an always-on peer improves availability without becoming the authority for ordinary records.

## Deploy an always-on peer

[![Deploy to Elestio](https://elest.io/images/logos/deploy-to-elestio-btn.png)](https://dash.elest.io/deploy?source=cicd&social=dockerCompose&url=https://github.com/taskasaur/taskasaur)

The button opens Elestio's Docker Compose deployment flow for this repository. Choose a small VM and review the provider's [current pricing](https://elest.io/pricing); its managed entry plans start at $11/month at the time of writing. The checked-in [template](elestio.yml) pulls the verified container image, attaches persistent storage and routes HTTPS/WSS to its peer port. No frontend is exposed. Pair the new device with your workspace using the [headless setup steps](docs/self-hosting.md#pair-a-headless-peer). Deployment requires your provider account; the button does not create an account or pair a workspace automatically.

```sh
cp .env.example .env.peer
docker compose --env-file .env.peer up -d --build
```

Compose defaults to `TASKASAUR_MODE=server`, `TASKASAUR_SERVE_UI=0` and `TASKASAUR_STORAGE_ONLY=1`. This independent storage/relay peer skips plugin execution services and their SQL projection. Set storage-only to `0` and enable individual capabilities when you want it to execute work. To serve the UI, explicitly choose `TASKASAUR_MODE=peer` and `TASKASAUR_SERVE_UI=1`.

In **Settings → Storage copies**, choose per record or file version which devices keep a copy, from any workspace editor's device. Core waits for a verified handoff before removing a copy. Removing the last retained version requires explicit confirmation. See the [storage contract and limits](docs/plugins/storage-placement.md).

## Capabilities

Records, files, plugin UI, pairing, credentials and foreground TypeScript automation use the shared portable core. Phones and browsers suspend when the platform suspends the app. Desktop and headless peers can run background services and host native terminals when enabled locally. iOS and Android can control an approved computer’s terminal; they do not expose an OS shell.

```sh
npm run peer -- --data /path/to/taskasaur-data --no-ui --relay
npm run peer -- --terminal --automation --trusted-code --background --plugins
```

The desktop **Devices** page has the equivalent switches. Closing its window leaves services in the tray; Quit stops them. Automation targets never silently move to another computer. Native plugins are trusted code and require an explicit local capability opt-in plus package approval.

```sh
docker compose --env-file .env.peer pull
docker compose --env-file .env.peer up -d             # Upgrade the image while retaining local data
```

The `edge` image follows verified `main` builds; pin a published `sha-…` tag or digest for repeatable deployments. Release builds also publish version tags.

See [self-hosting](docs/self-hosting.md), [replication and recovery](docs/distributed.md), and the [plugin specification](docs/plugins/README.md). Offline office engine provisioning and its platform constraints are described in [office engine](docs/office-engine.md).

## Build and verify

```sh
npm run typecheck
npm test
npm run build:web
npm run build:peer
npm run build:desktop
npm run prepare:ios
npm run prepare:android
```

Native packaging requires the corresponding platform SDK. `tests/browser/distributed.ts` exercises two real browser profiles through a temporary native peer; set `TEST_APP_URL` to a built UI and run it with `node --import tsx`. It downloads the published Tasks package, tests pairing, synchronization, offline reload and reconnection. `tests/browser/office.mjs` checks offline editing and actual Office export contents. `tests/browser/desktop.mjs` checks Electron startup and its native PTY; set `TASKASAUR_DESKTOP_EXECUTABLE` to test a packaged executable. `TASKASAUR_IMAGE=<image> node tests/container.mjs` checks container replacement and GUI-disabled mode using a temporary volume.

Existing history is preserved. The distributed implementation starts after commit `4159a2e`; reverting code does not automatically downgrade or delete application data. Keep backups when switching application generations.
