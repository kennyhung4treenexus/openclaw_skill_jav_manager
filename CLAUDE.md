# JAV Manager Project

## Canonical Context

Use `docs/PROJECT_CONTEXT.md` as the source of truth for architecture, runtime
paths, stage behaviour, safety boundaries, scheduler notes, and validation
commands.

If this file conflicts with `docs/PROJECT_CONTEXT.md` or recent task artifacts
under `docs/dev-workflow/`, follow `docs/PROJECT_CONTEXT.md` first, then the
latest task artifact.

This file is operational memory for coding agents working in:

```text
/home/hungsvradmin/apps/jav-manager
```

## Project Identity

Project name: JAV Manager
Runtime app path: `/home/hungsvradmin/apps/jav-manager`
OpenClaw skill path: `/home/hungsvradmin/.openclaw/skills/jav-manager`
Runtime state path: `/home/hungsvradmin/.local/state/jav-manager`
Target user: Kenny only

Purpose: run a seven-stage personal automation pipeline that scrapes configured
JavDB maker pages, enriches and maintains a Notion database, verifies MissAV
URLs, syncs ranking checkboxes, sends Telegram summaries, and cleans runtime
artifacts.

Optimise for reliability, conservative production writes, low operational
burden, clear rollback, and predictable scheduler behaviour.

## Current Operating Model

This is a production automation, not a throwaway scraper. Treat these as
production side effects:

- Notion page create/update/archive operations
- Telegram sends
- Docker / FlareSolverr container restart or recreate operations
- systemd service or timer lifecycle changes
- cleanup that deletes cache, logs, artifacts, browser sessions, or processes

For code-only documentation edits, tests and syntax checks are enough. For
runtime or scheduler changes, first verify no active pipeline is running.

## Architecture

Pipeline:

```text
config.json makers/favorites/filters
  -> Stage 01 ingest: JavDB via FlareSolverr
  -> runtime cache under ~/.local/state/jav-manager/cache/
  -> Stage 02 enrich: Notion page creation and cover upload
  -> Stage 03 verify-url: MissAV URL health state machine
  -> Stage 04 rankings: MissAV ranking scrape and Notion checkbox sync
  -> Stage 05 archive: Notion status/archive retention
  -> Stage 06 notify: Telegram HTML notification and snapshot diffs
  -> Stage 07 delete: cleanup, recycle bin, orphan Chromium cleanup
```

Runtime stack:

| Area | Current choice |
|---|---|
| OS | Ubuntu Server |
| Language | Node.js ESM |
| Required Node | `>=22.0.0` |
| CLI entrypoint | `index.mjs` |
| Config | `.env` plus `config.json` |
| Scraping transport | FlareSolverr Docker containers |
| HTML parsing | Cheerio |
| External datastore | Notion database |
| Notifications | Telegram via Telegraf |
| Scheduler | systemd user service/timers |
| Tests | `node --test` |

Runtime files:

```text
App:           /home/hungsvradmin/apps/jav-manager
Skill guide:   /home/hungsvradmin/.openclaw/skills/jav-manager
State:         /home/hungsvradmin/.local/state/jav-manager
Wrapper logs:  /home/hungsvradmin/.local/state/jav-manager/logs
App logs:      /home/hungsvradmin/.local/state/jav-manager/app-logs
Secrets:       /home/hungsvradmin/apps/jav-manager/.env
```

Secrets must not be committed or copied into reports, prompts, chat, or generated
docs. Do not reveal raw `.env` values unless Kenny explicitly asks.

## Important Files

| Path | Purpose |
|---|---|
| `docs/PROJECT_CONTEXT.md` | Canonical project overview and durable project knowledge. |
| `CLAUDE.md` | Agent-facing operational memory for this repo. |
| `README.md` | Human quickstart and safe command reference. |
| `.env` | Production secrets and runtime knobs. Never print or commit values. |
| `.env.example` | Non-secret environment template; update when adding env vars. |
| `config.json` | Maker URLs, favourites, aliases, maker aliases, and code filters. |
| `index.mjs` | CLI dispatcher for the seven stages and full pipeline cleanup hook. |
| `lib/shared.mjs` | Path resolution, JSON IO, logging, alerts, sleep/retry helpers, FlareSolverr restart helpers. |
| `lib/net/flaresolverr-pool.mjs` | FlareSolverr pool, health checks, sticky worker ports, session rotation, cooldowns. |
| `lib/scrapers/javdb-scraper.mjs` | JavDB scraping adapter; transport is injected by the caller. |
| `lib/ingest/` | Ingest locks, item cache, Notion code index, maker runner, run summaries. |
| `stages/01-ingest.mjs` | Scrape configured JavDB makers and write per-item cache. |
| `stages/02-enrich.mjs` | Create Notion pages from ingest cache and upload covers. |
| `stages/03-verify-url.mjs` | Verify MissAV URL columns using retry/bootstrap/visible tasks. |
| `stages/04-rankings.mjs` | Scrape ranking pages and sync Notion ranking checkboxes with safety gates. |
| `stages/05-archive.mjs` | Two-tier Notion retention: inactive after 30 days, archive after 365 days. |
| `stages/06-notify.mjs` | Telegram report for new videos, ranking changes, triple crowns, and failed items. |
| `stages/07-delete.mjs` | Cleanup with dry-run default, protected files, recycle bin, lock guards. |
| `tools/clean-notion.mjs` | Destructive Notion cleanup utility. Do not run without explicit approval. |
| `post-pipeline.sh` | Recreates FlareSolverr containers after full pipeline runs. |

## Stage Notes

Stage 01:

- Acquires `cache/ingest.lock`.
- Fetches existing Notion codes to dedupe.
- Restarts FlareSolverr before scraping.
- Uses worker queue with sticky FlareSolverr ports and session rotation.
- Writes per-item JSON and covers under runtime cache.
- Rebuilds `ingest-index.json` and merged `metadata.json` for compatibility.

Stage 02:

- Aborts if Stage 01 ingest lock is active.
- Reads per-item ingest cache.
- Batch-fetches existing Notion codes.
- Creates Notion pages and uploads cover files.
- `concurrency` affects Notion write pressure; be conservative.

Stage 03:

- Maintains `cache/url-health.json`.
- Verifies two volatile Notion URL columns: `URL no code` and `URL Chinese`.
- Uses visible, retry, and bootstrap task types.
- Unknown results do not clear Notion URLs.
- Invalid visible URLs must fail twice before clearing.

Stage 04:

- Scrapes MissAV ranking categories and syncs `Daily Star`, `Weekly Star`, and
  `Monthly Star` checkboxes.
- Safety gate allows unchecking only when a category scrape is healthy.
- Dry-run still reads Notion and computes full diffs.
- Writes summaries and test artifacts under runtime cache.

Stage 05:

- Active records older than 30 days become `Inactive [Archive]`.
- Inactive archive records older than 365 days are archived/trash in Notion.
- A very old Active record may be updated and archived in the same run by design.

Stage 06:

- Finds new videos from ingest cache and recent Notion rows.
- Diffs ranking snapshots and triple-crown snapshots.
- Sends Telegram with HTML parse mode.
- Writes `cache/notify-summary.json`.

Stage 07:

- Dry-run is the default when called directly as a module.
- Deletes runtime cache/artifacts/logs by retention policy and soft-deletes to
  `.trash/` where applicable.
- Protects long-lived state files such as URL health, ranking snapshots, and
  notified code history.
- Can kill orphan Chromium processes owned by the current user.

## Commands

Development:

```bash
cd /home/hungsvradmin/apps/jav-manager
npm test
node --check index.mjs
```

Direct stage commands:

```bash
cd /home/hungsvradmin/apps/jav-manager
node index.mjs ingest --dry-run --limit=5
node index.mjs enrich --dry-run --limit=5
node index.mjs verify --dry-run --limit=5
node index.mjs rankings --dry-run
node index.mjs archive --dry-run
node index.mjs notify --dry-run
node index.mjs delete --dry-run
```

Preferred full scheduled wrapper:

```bash
/home/hungsvradmin/scripts/run-jav-pipeline.sh --check-only
/home/hungsvradmin/scripts/run-jav-pipeline.sh
```

The full wrapper uses:

```text
timeout --preserve-status --signal=TERM --kill-after=120s 5h node --max-old-space-size=8192 index.mjs all
```

## Scheduler and Monitoring

Active scheduler is user systemd:

```text
~/.config/systemd/user/jav-pipeline.service
~/.config/systemd/user/jav-pipeline.timer
~/.config/systemd/user/jav-pipeline-alert.service
~/.config/systemd/user/jav-pipeline-watchdog.service
~/.config/systemd/user/jav-pipeline-watchdog.timer
```

Scheduled full pipeline slots:

```text
05:00, 11:00, 17:00, 23:00 HKT
```

Watchdog checks:

```text
05:25, 11:25, 17:25, 23:25 HKT
```

Use these read-only checks before risky work:

```bash
systemctl --user show jav-pipeline.service -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager
pgrep -af 'node --max-old-space-size=8192 index\.mjs all|run-jav-pipeline\.sh|timeout .*index\.mjs all' || true
```

## Validation Rules

For docs-only changes:

```bash
test -s CLAUDE.md && test -s README.md && test -s docs/PROJECT_CONTEXT.md
```

For JavaScript changes:

```bash
node --check index.mjs
find lib stages tools -name '*.mjs' -print0 | xargs -0 -n1 node --check
npm test
```

For wrapper or systemd-adjacent changes:

```bash
/home/hungsvradmin/scripts/run-jav-pipeline.sh --check-only
/home/hungsvradmin/scripts/jav-pipeline-alert.sh --check-only
/home/hungsvradmin/scripts/jav-pipeline-watchdog.sh --check-only
systemd-analyze --user verify ~/.config/systemd/user/jav-pipeline*.service ~/.config/systemd/user/jav-pipeline*.timer
```

Do not run live Notion, Telegram, Docker, cleanup, or scheduler operations just
to validate unrelated code.

## Safety Rules

- Ask Kenny before destructive or externally visible actions.
- Do not run `tools/clean-notion.mjs` without explicit approval.
- Do not change Notion database ID, Telegram target, schedule frequency, archive
  policy, cleanup policy, or FlareSolverr Docker lifecycle without calling out
  the risk and rollback.
- Do not edit `.env` unless specifically requested.
- Back up `config.json` before maker scope or filter changes.
- For failed pipeline troubleshooting, report the exit code and the relevant log
  tail; do not treat an OpenClaw agent turn as pipeline success.

## Dev-Workflow Guidance

Default mode for small docs/tests changes: `bugfix-light`.

Use `full-workflow` for:

- stage behaviour changes
- Notion write behaviour
- Telegram output behaviour
- FlareSolverr pool or Docker lifecycle changes
- cleanup/archive/delete behaviour
- systemd wrappers, timers, watchdogs, or alerts

Update `docs/PROJECT_CONTEXT.md` whenever durable facts change about
architecture, state layout, stage responsibilities, commands, scheduler, tests,
or safety boundaries.
