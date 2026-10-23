# JAV Manager

Seven-stage personal automation pipeline for maintaining Kenny's JAV Notion
database from configured JavDB maker sources.

**GCP source path:** `/home/hungsvradmin/apps/jav-manager`
**GCP runtime state:** `/home/hungsvradmin/.local/state/jav-manager`
**OpenClaw skill:** `/home/hungsvradmin/.openclaw/skills/jav-manager`

For the full current project state, stage details, scheduler notes, and safety
guardrails, use `docs/PROJECT_CONTEXT.md` as the source of truth.

## What It Does

```text
JavDB maker pages
  -> ingest metadata and covers
  -> create/update Notion records
  -> verify MissAV URLs
  -> sync MissAV ranking checkboxes
  -> archive old Notion records
  -> send Telegram summary with favorite-actress markers
  -> clean runtime artifacts
```

## Development

```bash
cd /home/hungsvradmin/apps/jav-manager

# Install dependencies if needed
npm install

# Run tests
npm test

# Syntax check entrypoint
node --check index.mjs
```

## Safe Checks

```bash
cd /home/hungsvradmin/apps/jav-manager

# Wrapper preflight; no pipeline run
/home/hungsvradmin/scripts/run-jav-pipeline.sh --check-only

# Stage dry-runs
node index.mjs ingest --dry-run --limit=5
node index.mjs enrich --dry-run --limit=5
node index.mjs verify --dry-run --limit=5
node index.mjs rankings --dry-run
node index.mjs archive --dry-run
node index.mjs notify --dry-run
node index.mjs delete --dry-run
```

Note: some dry-runs still read live services such as Notion or scrape through
FlareSolverr. They should not write externally, but they are not fully offline
unit tests.

## Full Pipeline

Preferred wrapper:

```bash
/home/hungsvradmin/scripts/run-jav-pipeline.sh
```

Direct app command:

```bash
cd /home/hungsvradmin/apps/jav-manager
node --max-old-space-size=8192 index.mjs all
```

The wrapper adds locking, a 5-hour timeout, timestamped logs, latest-log symlink,
and a real process exit code for systemd.

## Individual Stages

```bash
node index.mjs ingest
node index.mjs enrich
node index.mjs verify
node index.mjs rankings
node index.mjs archive
node index.mjs notify
node index.mjs delete
```

Most stage commands accept:

```text
--dry-run
--verbose
--limit=<n>
```

Stage-specific options include:

```text
--workers=<n>
--max-pages-per-maker=<n>
--visible-only
--retry-only
--concurrency=<n>
--max-retry-items=<n>
```

## Runtime Paths

```text
GCP source:       /home/hungsvradmin/apps/jav-manager
GCP secrets:      /home/hungsvradmin/apps/jav-manager/.env
GCP config:       /home/hungsvradmin/apps/jav-manager/config.json
Runtime cache:    /home/hungsvradmin/.local/state/jav-manager/cache
Wrapper logs:     /home/hungsvradmin/.local/state/jav-manager/logs
App logs:         /home/hungsvradmin/.local/state/jav-manager/app-logs
Browser sessions: /home/hungsvradmin/.local/state/jav-manager/session

Edge releases:    /srv/alfred/prod/jav-manager/releases/<exact-sha>
Edge current:     /srv/alfred/prod/jav-manager/current
Edge config:      /srv/alfred/shared/jav-manager/config
Edge state/logs:  /srv/alfred/shared/jav-manager/{state,logs}
```

`JAV_MANAGER_CONFIG_ROOT`, `JAV_MANAGER_STATE_DIR`, and
`JAV_MANAGER_ENV_FILE` keep mutable config, secrets, state, and logs outside
an immutable release.

## Edge Shadow Safety

- `JAV_SHADOW_MODE=true` requires `--dry-run` at both CLI and direct stage
  boundaries.
- Edge JAV uses only ports `8291-8293`. Shadow mode rejects News-owned
  `8191-8193`.
- Session rotation uses FlareSolverr `sessions.destroy`; it never restarts a
  container.
- Normal unprivileged post-pipeline handling validates the exact systemd unit
  provenance and expanded `alfred.owner=jav-manager`, `alfred.port`,
  `alfred.purpose=jav-active`, loopback-listener, and HTTP-health contract.
  An explicitly configured privileged Docker backend is required before any
  optional restart.
- Edge pipeline and watchdog timers use `Persistent=false` and remain
  disabled during AE-10.

## Scheduler

The accepted schedule shape is:

```text
05:00, 11:00, 17:00, 23:00 HKT
```

Project Alfred Edge AE-10 is a disabled zero-side-effect shadow. It does not
enable this schedule or move scheduler authority.

Useful read-only status commands:

```bash
systemctl --user show jav-pipeline.service -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager
systemctl --user list-timers jav-pipeline.timer jav-pipeline-watchdog.timer --all --no-pager
journalctl --user -u jav-pipeline.service -n 120 --no-pager
tail -120 /home/hungsvradmin/.local/state/jav-manager/logs/jav-pipeline-latest.log
```

## Safety

- `.env` contains production secrets. Do not commit or print its values.
- Notion, Telegram, Docker, and systemd writes are production side effects.
- `tools/clean-notion.mjs` is destructive. Do not run it without explicit
  approval.
- Stage 05 archives Notion pages. Stage 07 deletes/prunes runtime artifacts and
  can kill orphan Chromium processes.
- Before structural edits or manual full runs, verify no scheduled pipeline is
  active.

## Documentation

Primary docs:

```text
CLAUDE.md
README.md
docs/PROJECT_CONTEXT.md
```

`docs/PROJECT_CONTEXT.md` is the durable knowledge base for `dev-workflow`,
Codex, Claude Code, and future agents. Keep it updated when architecture,
runtime paths, stage behaviour, validation commands, or safety boundaries change.
