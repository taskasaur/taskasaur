# Run an always-on Taskasaur peer

The Docker image runs the same core as other devices, plus native capabilities. One persistent `/data` volume contains its identity, encrypted replica journals/files, and, when enabled, installed plugin packages, an embedded SQL projection and workflow checkpoints. There is no external database/auth/storage service.

```sh
cp .env.example .env.peer
# Edit .env.peer for this deployment; keep existing installation settings separately.
docker compose --env-file .env.peer up -d --build
```

Compose starts in **server mode** with no initial workspace. Join an existing workspace using the steps below. Each container has its own durable device identity; it is an ordinary peer, never a central database authority.

| Compose parameter            | Default            | Effect                                                                                                                                                   |
| ---------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TASKASAUR_MODE`             | `server`           | Never serve frontend assets, even if the UI flag is on. Set `peer` to allow a GUI.                                                                       |
| `TASKASAUR_SERVE_UI`         | `0`                | GUI switch for `peer` mode.                                                                                                                              |
| `TASKASAUR_STORAGE_ONLY`     | `1`                | Skip the native plugin SQL projection, automation engines and terminal services. Incompatible execution opt-ins fail clearly.                            |
| `TASKASAUR_SYNC_INTERVAL_MS` | `15000`            | Coalesced background synchronization interval (1,000–3,600,000 ms).                                                                                      |
| `TASKASAUR_DOCUMENT_CACHE`   | `128`              | Target number of active Automerge documents before compressed save/load; control documents and signed journals remain indexed. Not a total memory bound. |
| `TASKASAUR_RELAY`            | `1`                | Offer libp2p relay connectivity.                                                                                                                         |
| `TASKASAUR_NAME`             | `Taskasaur server` | Name used when creating a new device identity.                                                                                                           |

To run native plugins on this peer, set storage-only to `0`, then opt into the needed execution capabilities. This still works with server mode and the GUI disabled. To serve the same app interface, set mode to `peer` and UI to `1`.

UI and health endpoints use port 8080. Peer WebSockets use port 8787. `TASKASAUR_SERVE_UI=0` disables the GUI files while retaining health and peer services. Terminal, automation, trusted TypeScript, background plugin work and remote native-plugin installation are separate opt-ins, disabled by default. A terminal inside Docker controls the container, not the host computer.

Set `TASKASAUR_ANNOUNCE` to a comma-separated list of reachable libp2p multiaddresses, without the final peer ID. Example: `/dns4/peer.example.com/tcp/443/wss`. Put the peer WebSocket port behind a TLS reverse proxy that forwards WebSocket upgrades; put the UI behind HTTPS as well. The UI needs COOP `same-origin` and COEP `require-corp` for its optional office engine. Loopback HTTP is supported for local development. A browser on another machine cannot use the container’s internal IP address.

## Pair a headless peer

Management commands require exclusive access to the data directory. Stop its normal process first. With Docker, use `docker compose run --rm --no-deps taskasaur node dist-peer/main.js ...` after `docker compose stop taskasaur`. `compose run` uses the same volume and does not publish ports by default.

```sh
npm run peer -- --data ./my-peer --name 'Home computer' --pairing-request --output request.json
# Approve request.json in an existing workspace owner's Devices page.
npm run peer -- --data ./my-peer --join invitation.json
npm run peer -- --data ./my-peer --host 0.0.0.0 --relay
```

A headless workspace owner can approve a request with `--approve request.json --workspace-id <uuid> --output invitation.json`. Device requests contain public keys. Invitations are encrypted to the approved device. Add the headless peer’s advertised address in the other device’s peer connections.

With `TASKASAUR_STORAGE_ONLY=0`, use `--plugin <id> --workspace-id <uuid>` while the daemon is stopped to install a signed package and its dependencies. Alternatively enable `--plugins` locally, then use Devices to review and install native services on that computer. Keep secrets in core Credentials; grant the chosen execution device access to the relevant secret.

## Update and recover

```sh
docker compose --env-file .env.peer pull
docker compose --env-file .env.peer up -d
```

The default `edge` image follows verified builds from `main`. Pin a published `sha-<commit>`, release version or digest in `TASKASAUR_IMAGE` for a stable deployment. Source deployments use `--build`; an image must finish publishing before `pull` can obtain it. Do not delete the data volume on update. Back up the entire volume with the peer stopped before major upgrades or code rollback. The health endpoint is `/api/health` and does not return workspace contents or identities.

Documents, spreadsheets and presentations work offline with the editors bundled into the image. `OFFICE_ASSET_PATH` optionally mounts a compatible LibreOffice engine for additional format fidelity; that engine has a separate large upstream distribution. See [office provisioning](office-engine.md).

## Recovery and webhooks

With the peer stopped, export a portable encrypted backup using `npm run peer -- --data <directory> --backup device.json --passphrase-file <private-file>`. Restore with `--restore device.json` into an empty profile after retiring the original identity. Protect the passphrase file with operating-system permissions. Preserve the entire stopped data directory as well for native plugin installations and workflow SQLite checkpoints.

Create a webhook in the automation editor on the workflow's selected native peer. Send JSON to that peer's returned `/api/automation/hooks/<workflow-id>` path with `Authorization: Bearer <token>` and a stable `Idempotency-Key`. Requests are limited to 1 MiB. Expose this endpoint through HTTPS when using it beyond loopback. Webhooks execute only on the selected device and require its automation capability to be enabled.

## Elestio deployment

The README button uses Elestio's documented [Docker Compose CI/CD template](https://docs.elest.io/books/cicd-pipelines/page/create-your-own-template-elestioyml). The root `elestio.yml` builds `compose.yaml` on the selected VM and routes its public HTTPS endpoint to the peer WebSocket port. `[CI_CD_DOMAIN]` becomes the assigned hostname. Choose the VM/provider/region and review its current bill before creating it; this is a paid managed VM, with persistent disk rather than ephemeral serverless storage. The template targets Elestio's Docker bridge (`172.17.0.1`) and proxy. Other hosts should leave the regular Compose bind defaults and supply their own TLS proxy.

For Compose pairing, stop the running service and generate its public request in the persistent volume:

```sh
docker compose --env-file .env.peer stop taskasaur
docker compose --env-file .env.peer run --rm --no-deps taskasaur node dist-peer/main.js --pairing-request --output /data/request.json
docker compose --env-file .env.peer run --rm --no-deps taskasaur cat /data/request.json
```

Approve that request in **Settings menu → Devices** on your existing workspace owner device. Save the returned invitation as `invitation.json` in the current directory, then pass that file to the stopped peer:

```sh
docker compose --env-file .env.peer run --rm --no-deps -v "$PWD/invitation.json:/run/invitation.json:ro" taskasaur node dist-peer/main.js --join /run/invitation.json
docker compose --env-file .env.peer up -d
```

On Elestio, run the same commands in the deployed checkout using its configured environment (omit `--env-file .env.peer` if the dashboard injects those values). Copying the invitation into the container is a one-time management operation. Once paired, add the peer's announced multiaddress, including its `/p2p/…` suffix from startup logs, to the other device. The endpoint is a peer WebSocket service, so opening its cloud URL in a browser is not expected to show the app. Health remains on loopback port 8080 and is not the publicly routed service.

Manage copies in **Settings → Storage copies**, or the storage action on a record/file. Offline requests wait for reconnection. Disabling retention is not deletion; the last copy remains until handoff or explicit version deletion. See [placement, histories and recovery limits](plugins/storage-placement.md).
