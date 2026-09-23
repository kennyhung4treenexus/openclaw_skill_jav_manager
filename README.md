# JAV Manager

Seven-stage personal automation pipeline for maintaining Kenny's JAV Notion
database from configured JavDB maker sources.

**Development/source path:** `/home/hungsvradmin/apps/jav-manager`
**Production:** immutable release on the accepted Alfred Edge host
**Runtime state:** `/srv/alfred/shared/jav-manager/state`
**OpenClaw skill:** `/home/hungsvradmin/.openclaw/skills/jav-manager`

For the full current project state, stage details, scheduler notes, and safety
guardrails, use `docs/PROJECT_CONTEXT.md` as the source of truth.

The GCP checkout is source/rollback material. Production runs from
`/srv/alfred/prod/jav-manager/current` on Edge; do not edit an accepted release
in place. Always resolve the accepted authority record before production
operations.

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
GCP source/rollback: /home/hungsvradmin/apps/jav-manager
Edge current:        /srv/alfred/prod/jav-manager/current
Edge config:         /srv/alfred/shared/jav-manager/config
Edge runtime cache:  /srv/alfred/shared/jav-manager/state/cache
Edge wrapper logs:   /srv/alfred/shared/jav-manager/logs
Edge browser state:  /srv/alfred/shared/jav-manager/state/session
```

## Scheduler

Edge user systemd runs the full pipeline at:

```text
05:00, 11:00, 17:00, 23:00 HKT
```

Useful read-only status commands:

```bash
systemctl --user show jav-pipeline.service -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager
systemctl --user list-timers jav-pipeline.timer jav-pipeline-watchdog.timer --all --no-pager
journalctl --user -u jav-pipeline.service -n 120 --no-pager
tail -120 /srv/alfred/shared/jav-manager/logs/jav-pipeline-latest.log
```

Run these commands on the accepted Edge host. GCP JAV timers remain disabled;
do not enable two scheduler authorities.

## Watcher alerts

Operational OnFailure/watchdog alerts use `JAV_ALERT_ACCOUNT=default`. The live
Telegram binding maps `default` to `alfred-gate`, so alerts and replies appear
in the Alfred Gate Telegram conversation.

The alert helper performs direct authenticated Gateway `send`; it does not
invoke Gate or automatically dispatch `jav-ops`. Its fixed message asks for
`jav-ops` follow-up. This is separate from the Stage 06 pipeline-summary
Telegram notification path.

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
