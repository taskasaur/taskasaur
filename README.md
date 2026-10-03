# Taskasaur

A TypeScript workspace with an independent, durable local copy on every approved device. React provides the same interface in the browser, Electron and Capacitor. Devices exchange signed Automerge changes and encrypted file chunks through libp2p. No central application server, hosted account or external database is required.

This repository owns the shared core, UI, platform adapters, headless peer and plugin SDK. The previous server repository is not used or modified. Optional plugins remain independent, signed packages discovered through a configurable JSON inventory.

## Run

Use Node.js 24 or later.

```sh
npm ci
npm run dev                       # http://localhost:5173
npm run build
npm run peer -- --workspace Home  # http://127.0.0.1:8080; peer port 8787
npm run electron:dev
```

Create a workspace on the first device. On another device, choose **Join workspace**, copy its device request, and approve it in the first device’s **Devices** page. Return the encrypted invitation to the joining device. Add a reachable peer address and synchronize. The invitation is bound to that device’s public keys.

A browser cannot accept an ordinary TCP listener. Connect it to a reachable native/headless peer or libp2p relay; WebRTC and relay transport are available. Internet browser connections need HTTPS/WSS. No public relay is silently selected. All approved peers keep their own copies; an always-on peer improves availability without becoming the authority for ordinary records.

## Capabilities

Records, files, plugin UI, pairing, credentials and foreground TypeScript automation use the shared portable core. Phones and browsers suspend when the platform suspends the app. Desktop and headless peers can run background services and host native terminals when enabled locally. iOS and Android can control an approved computer’s terminal; they do not expose an OS shell.

```sh
npm run peer -- --data /path/to/taskasaur-data --no-ui --relay
npm run peer -- --terminal --automation --trusted-code --background --plugins
```

The desktop **Devices** page has the equivalent switches. Closing its window leaves services in the tray; Quit stops them. Automation targets never silently move to another computer. Native plugins are trusted code and require an explicit local capability opt-in plus package approval.

```sh
docker compose up -d --build      # One Taskasaur peer, persistent /data volume
docker compose pull
docker compose up -d             # Upgrade the image while retaining local data
```

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
