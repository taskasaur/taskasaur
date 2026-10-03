# Run an always-on Taskasaur peer

The Docker image runs the same core as other devices, plus native capabilities. One persistent `/data` volume contains its identity, encrypted replica journals/files, installed plugin packages, embedded SQL projection and workflow checkpoints. There is no external database/auth/storage service.

```sh
cp .env.example .env.peer
# Edit .env.peer for this deployment; keep existing installation settings separately.
docker compose --env-file .env.peer up -d --build
```

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

Use `--plugin <id> --workspace-id <uuid>` while the daemon is stopped to install a signed package and its dependencies. Alternatively enable `--plugins` locally, then use Devices to review and install native services on that computer. Keep secrets in core Credentials; grant the chosen execution device access to the relevant secret.

## Update and recover

```sh
docker compose --env-file .env.peer pull
docker compose --env-file .env.peer up -d
```

Use a published version/digest in `TASKASAUR_IMAGE`. The default image name is a release target; local development uses `--build`. Do not delete the data volume on update. Back up the entire volume with the peer stopped before major upgrades or code rollback. The health endpoint is `/api/health` and does not return workspace contents or identities.

Documents, spreadsheets and presentations work offline with the editors bundled into the image. `OFFICE_ASSET_PATH` optionally mounts a compatible LibreOffice engine for additional format fidelity; that engine has a separate large upstream distribution. See [office provisioning](office-engine.md).

## Recovery and webhooks

With the peer stopped, export a portable encrypted backup using `npm run peer -- --data <directory> --backup device.json --passphrase-file <private-file>`. Restore with `--restore device.json` into an empty profile after retiring the original identity. Protect the passphrase file with operating-system permissions. Preserve the entire stopped data directory as well for native plugin installations and workflow SQLite checkpoints.

Create a webhook in the automation editor on the workflow's selected native peer. Send JSON to that peer's returned `/api/automation/hooks/<workflow-id>` path with `Authorization: Bearer <token>` and a stable `Idempotency-Key`. Requests are limited to 1 MiB. Expose this endpoint through HTTPS when using it beyond loopback. Webhooks execute only on the selected device and require its automation capability to be enabled.
