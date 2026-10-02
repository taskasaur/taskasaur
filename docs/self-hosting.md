# Self-hosting Taskasaur

Use Node.js 24 for setup/build tooling and Docker Compose v2. The deployment is derived from the [official Supabase Docker example](https://github.com/supabase/supabase/tree/self-hosted/v0.8.2/docker), following [Supabase's self-hosting guide](https://supabase.com/docs/guides/self-hosting/docker). Supabase provides a Compose bundle of services; Taskasaur supplies its own app/worker image alongside them.

## Upstream baseline and changes

`deploy/supabase/upstream/` contains the unchanged `docker/` directory from release `self-hosted/v0.8.2`, commit `564eab8ad7840b13324f68b1bfac074ef8d51c21`. `deploy/supabase/UPSTREAM.json` records the source and SHA-256 of every file. The upstream Apache license is retained.

`compose.yaml` is generated from that official file plus `deploy/docker/taskasaur.yaml`. The generator resolves upstream bind mounts, lets Compose name containers per project, merges Taskasaur's environment/service settings and uses named volumes for PostgreSQL, storage, plugins and office assets. The overlay adds the app, migration job, worker and public gateway. Studio, metadata administration, Realtime, the Edge Runtime and Supavisor remain available through the explicit `tools` profile. Core Auth, PostgreSQL, REST, Storage, image proxy and API gateway run by default. The Supabase API gateway has no public port in the production configuration.

```sh
npm run compose:generate  # After editing the Taskasaur overlay
npm run compose:verify   # Check upstream hashes and generated configuration
```

Do not edit the vendored bundle or run its reset/update scripts against a Taskasaur installation. To adopt a newer upstream release, download its complete Docker directory, record its revision/checksums, regenerate the overlay result and test an isolated restore before upgrading production. The retained upstream scripts are reference material; Taskasaur uses the root Compose project and its named volumes.

## Start

```sh
npm ci
npm run setup
docker compose config --quiet
docker compose build app
docker compose up -d
```

Setup uses the official `.env.example` as its starting defaults, generates unique database/JWT/vault credentials and writes `.env` with private permissions. Existing files are not overwritten by default. `npm run setup -- --merge` adds missing settings while preserving every existing value and secret. Keep `.env` with encrypted backups.

Open `http://localhost:3000`, create an account and enable the feature plugins you want. Before remote access, configure `PUBLIC_APP_URL`, `SITE_URL`, `API_EXTERNAL_URL`, allowed redirect URLs and TLS termination for the public gateway. The current local setup auto-confirms signups; configure SMTP and email confirmation for your deployment. Never expose PostgreSQL or the internal Supabase gateway just to use the app.

The public gateway routes app/API requests and `/device-stream`. App and worker use the same versioned image and durable plugin volume. The migration job must succeed before either starts; the web health check confirms schema availability. Office engine provisioning is separate persistent release data; see [office-engine.md](office-engine.md) for current engine readiness and platform limitations.

## Development

```sh
docker compose -p taskasaur-rebuild-test -f compose.yaml -f compose.dev.yaml up -d
npm run dev:stack
```

The development override binds PostgreSQL to `127.0.0.1:58532` and the internal Supabase gateway to `127.0.0.1:58521`. The dev web host runs on port 3210. It loads `.env` without printing secrets. Use one development stack at a time with these port defaults. The worker mounts source for development; rebuild its image when dependencies change.

Use `docker compose --profile tools up -d` only when the Supabase administration services are needed. The pooler ports are loopback-only. Studio can be reached through an explicitly configured private administrative proxy to the internal API gateway; enabling the profile does not expose it publicly.

## Update and recover

Set `TASKASAUR_IMAGE` to an existing, tested version or digest. The default `taskasaur/taskasaur:0.2.0` is a local build tag, not a claim that an image has been published. With a published release image configured:

```sh
docker compose pull
docker compose up -d
```

Back up before an upgrade: stop app/worker writes, take a PostgreSQL custom-format dump, snapshot storage/plugin/office volumes and securely copy `.env`. Retain the previous image digest. Restore into an isolated project and verify credentials decrypt, file versions download and queued work retains its original device. Selecting an older app image does not reverse database migrations. Do not delete data volumes as an upgrade step.

Use `docker compose ps` and bounded service logs for diagnostics. Do not print expanded Compose configuration or installation secrets into support reports. Application tables and private files remain behind authenticated core authorization; the client cannot access the Taskasaur schema directly through PostgREST.
