# Docker operations on Windows

The production Compose project is `frameforge-studio`, with its existing persistent volume `frameforge-studio_studio-data`. Docker serves the editor on `127.0.0.1:4310`; the Windows host bridge provides authenticated agent calls and native SAPI speech. The Aside inbox remains a host process. Tailscale Serve forwards the same port.

## Normal start

From the repository root in PowerShell:

```powershell
& .\scripts\start-docker.ps1
```

The helper checks the Docker engine, requests `docker desktop start --detach` if needed, and waits up to 180 seconds for readiness. It requires the existing production volume, verifies ownership of an occupied port 4310, and checks that the volume contains a readable regular nonempty `studio.sqlite`. This database check uses the existing image in a temporary container with a read-only, no-copy volume mount, no network, and no supplied credentials. A pre-created empty volume is rejected before Compose can seed a new library. The helper then starts Compose with a 90-second health wait. Only after container health succeeds does it start the host bridge and Aside inbox. It does not launch the native Node studio, stop port owners, delete volumes, reset Docker, or restart Windows.

The default path neither builds nor pulls an image. To rebuild the reviewed source before startup:

```powershell
& .\scripts\start-docker.ps1 -Build
```

The build has a 20-minute client timeout. A timeout terminates only the helper's Docker CLI; inspect the Docker engine before retrying because server-side work may still be finishing. `--wait` and `--wait-timeout` are documented by [Docker Compose](https://docs.docker.com/reference/cli/docker/compose/up/); detached Desktop startup is documented in [Docker Desktop CLI](https://docs.docker.com/reference/cli/docker/desktop/start/).

## Native-to-Docker data migration

The 2026-10-18 migration used a separate staging project on port 4320, then stopped the idle native studio and inbox before taking the final snapshot. The host bridge stayed running. The final snapshot is retained privately at `ops/snapshots/production-20261018-0757`; `ops/production-import.json` records SQLite integrity, table counts, original IDs/versions and 10 media hashes. The sanitized API recheck is [docker-migration.json](../artifacts/docker-migration.json). Original `data/` remains untouched by the container.

For a future migration, first prove the same process in a distinct staging project/volume. Finish active jobs, stop only this project's native studio/inbox, and create a new snapshot destination:

```powershell
& .\scripts\stop-local.ps1 -Services @('studio','aside-inbox')
New-Item -ItemType Directory -Force ops/snapshots | Out-Null
$snapshotTarget = 'ops/snapshots/production-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
node scripts/snapshot-data.mjs --source data --snapshot-root ops/snapshots --target $snapshotTarget
if ($LASTEXITCODE -ne 0) { throw 'Snapshot failed; do not import' }
```

Initialize only a **new, empty** volume. The importer requires its complete manifest, validates database/media hashes and contained paths, uses exclusive copies, checks SQLite integrity/history/IDs/versions, then assigns ownership to the non-root service. Never point this initialization at the already migrated production volume.

```powershell
$migrationVolume = 'frameforge-studio_studio-data'
if ($migrationVolume -in @(docker volume ls --format '{{.Name}}')) { throw 'Existing volume: refuse overwrite' }
docker volume create --label com.docker.compose.project=frameforge-studio --label com.docker.compose.volume=studio-data $migrationVolume
if ($LASTEXITCODE -ne 0) { throw 'Volume creation failed' }
$snapshotAbsolute = (Resolve-Path $snapshotTarget).Path
$importScript = (Resolve-Path scripts/import-snapshot.mjs).Path
docker run --rm --user 0 --mount "type=volume,src=$migrationVolume,dst=/data" --mount "type=bind,source=$snapshotAbsolute,target=/snapshot,readonly" --mount "type=bind,source=$importScript,target=/import-snapshot.mjs,readonly" node:22-bookworm-slim node /import-snapshot.mjs --source /snapshot --target /data --uid 1000 --gid 1000
if ($LASTEXITCODE -ne 0) { throw 'Import failed; retain partial volume for diagnosis' }
& .\scripts\start-docker.ps1 -Build
```

An import failure leaves the incomplete volume for inspection and refuses a second overwrite. Retain snapshots and choose a new explicitly reviewed target for another attempt. After startup, authenticate through the service and compare original IDs, versions, history and downloaded media hashes. Run the real speech/render/browser tests and container restart verification before declaring the cutover complete.

For rollback, stop the owned production Compose service **without** `-v`, verify port 4310 is free, and start the native studio/inbox against the retained `data/`. That native copy represents cutover time: later Docker edits must be exported/merged before rollback to avoid losing newer work. The normal launcher deliberately refuses a missing production volume even on a new checkout.

## Configuration and authentication

Keep `.env` private and out of Git. Configure `LOGIN_TOKEN` and `AGENT_BRIDGE_TOKEN` without printing them. Compose uses `http://host.docker.internal:4311` for the host bridge unless `HOST_AGENT_BRIDGE_URL` is set. `SPEECH_PROVIDER=host-bridge` sends bounded text/voice requests and receives WAV bytes; container paths are never forwarded to Windows.

`PUBLIC_ORIGIN` must match the browser entry point. Use the production Tailscale HTTPS origin for normal access. A staging browser at `http://127.0.0.1:4320` needs a separate staging configuration with that origin or an empty origin. An HTTPS-only production origin intentionally rejects browser writes through a different local HTTP origin.

## Failure diagnosis

- **Port 4310 occupied:** identify the process and preserve current work. The helper permits only the labeled production Docker service with its expected loopback binding and recognized Docker/System listener. It refuses native Node or unknown owners. Do not kill arbitrary processes.
- **Missing volume:** restore/import the verified snapshot into the expected volume. Changing project names changes default volume names; do not let that produce a new empty library.
- **Unhealthy container:** inspect `docker compose -p frameforge-studio ps` and `docker compose -p frameforge-studio logs --tail 100 studio` locally. Logs can contain operational data; redact before sharing.
- **Engine/WSL unavailable:** inspect Docker Desktop diagnostics and the WSL service state. `scripts/repair-docker-wsl.ps1` previews its narrowly scoped recovery; it is a separate operation, never called by normal startup. Preserve guest work and follow its explicit prerequisites before applying recovery.
- **Speech/agents unavailable:** check the host bridge on port 4311 and its private log, installed Windows voices, and the container's authenticated bridge connectivity. Container health establishes editor readiness, not provider readiness.

Never use `docker compose down -v`, Docker factory reset, distribution unregister, or a replacement empty volume as a routine startup repair. These actions discard persistent data.

## Evidence without overwriting prior receipts

The production smoke supports `STUDIO_URL`, `PRODUCTION_RECEIPT_PATH`, and `PRODUCTION_MEDIA_DIR`. The browser smoke reads that production receipt and supports `BROWSER_RECEIPT_PATH` plus `BROWSER_SCREENSHOT_DIR`. Use distinct paths for staged Docker, live Docker, and earlier Windows-native evidence.

```powershell
$env:STUDIO_URL='https://desktop-qrf3t5t.taila2003e.ts.net'
$env:PRODUCTION_RECEIPT_PATH='artifacts/docker-live-production-smoke.json'
$env:PRODUCTION_MEDIA_DIR='data/docker-live-production-smoke'
$env:BROWSER_RECEIPT_PATH='artifacts/docker-live-production-browser-smoke.json'
$env:BROWSER_SCREENSHOT_DIR='docs/assets/docker-live'
node --env-file=.env scripts/production-smoke.mjs
python -B scripts/production-browser-smoke.py
```

These tests create a sample episode/workflow and persist automated review decisions. They verify production mechanics, not owner acceptance or publication. Browser narration, audio/video playback, final review persistence, and restart persistence require their own observed receipts; a healthy container alone does not establish them.
