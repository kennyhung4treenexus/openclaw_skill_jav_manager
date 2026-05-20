# Project Context - JAV Manager

## 1. Project Identity

Project name: **JAV Manager**

Runtime app path:

```text
/home/hungsvradmin/apps/jav-manager
```

OpenClaw skill path:

```text
/home/hungsvradmin/.openclaw/skills/jav-manager
```

Runtime state path:

```text
/home/hungsvradmin/.local/state/jav-manager
```

Purpose:

This is Kenny's personal production automation for maintaining a Notion database
of configured JAV releases. It scrapes configured JavDB maker pages, stores
runtime ingest artifacts, creates Notion records, verifies MissAV URLs, syncs
MissAV ranking flags, archives old records, sends Telegram summaries, and
cleans temporary runtime data.

Target user:

```text
Kenny only
```

This is not a public service or enterprise platform. Prioritise reliability,
conservative writes, operational clarity, safe rollback, and low maintenance
over generic framework abstraction.

---

## 2. Current Status

Current repo state as understood from source code, the `jav-manager` OpenClaw
skill, user systemd units, and wrapper scripts:

```text
Application split from skill folder: complete
Runtime state relocation to ~/.local/state/jav-manager: complete
Seven-stage pipeline implementation: active
Systemd user scheduler: active
Pipeline watchdog/alert path: active
Tests: node --test based, focused on scraper/archive/notify/delete logic
```

The app root is the production codebase. The OpenClaw skill folder is only a
thin operating guide/wrapper and should not contain app source, cache, logs,
secrets, or `node_modules/`.

Important current caveat:

```text
config.json has local production changes in the working tree. Do not overwrite,
reformat, or revert it unless Kenny explicitly asks.
```

---

## 3. Architecture Summary

High-level pipeline:

```text
config.json
  -> Stage 01 ingest
  -> cache/ingest item files and covers
  -> Stage 02 enrich
  -> Notion database
  -> Stage 03 verify-url
  -> Stage 04 rankings
  -> Stage 05 archive
  -> Stage 06 notify
  -> Stage 07 delete
```

External dependencies:

| Dependency | Used by | Notes |
|---|---|---|
| JavDB | Stage 01 | Maker listing and detail scraping through FlareSolverr. |
| MissAV | Stages 03, 04 | URL verification and ranking scraping through FlareSolverr. |
| FlareSolverr Docker | Stages 01, 03, 04 | Default ports `8191,8192,8193`. |
| Notion API | Stages 01, 02, 03, 04, 05, 06 | Existing-code lookup, page create/update/archive, notification queries. |
| Telegram Bot API | Stage 06 and alert scripts | Sends summaries and operational alerts. |
| OpenClaw gateway/CLI | Alert script | Starts Alfred when systemd pipeline fails or appears missed. |

Runtime stack:

| Area | Current choice |
|---|---|
| Language | Node.js ESM |
| Node engine | `>=22.0.0` |
| Package manager | npm |
| Entry point | `index.mjs` |
| Config | `.env` and `config.json` |
| Scraping | FlareSolverr pool plus Cheerio parsing |
| Browser/session fallback | `puppeteer-real-browser` support exists, but Stage 01 uses FlareSolverr mode |
| Notion client | `@notionhq/client` and custom helper in `lib/enrichers/notion-client.mjs` |
| Notifications | `telegraf` |
| Scheduler | systemd user timers |
| Tests | `node --test` |

---

## 4. Important Files and Directories

| Path | Purpose |
|---|---|
| `CLAUDE.md` | Agent-facing operational memory for this repo. |
| `README.md` | Human quickstart and safe command reference. |
| `docs/PROJECT_CONTEXT.md` | This durable project context file. |
| `.env` | Production secrets and runtime knobs. Do not print or commit values. |
| `.env.example` | Non-secret env var template and stage knobs. |
| `config.json` | Production maker/favorites/alias/filter configuration. |
| `index.mjs` | CLI dispatcher and full-pipeline orchestrator. |
| `package.json` | Node engine, scripts, and dependencies. |
| `post-pipeline.sh` | Recreates FlareSolverr containers after full pipeline completion. |
| `lib/shared.mjs` | Path resolver, JSON IO, logging, OpenClaw alert helper, retries, sleep, FlareSolverr restart. |
| `lib/net/flaresolverr-pool.mjs` | Shared FlareSolverr health, request, cooldown, sticky-worker, session-rotation logic. |
| `lib/scrapers/javdb-scraper.mjs` | JavDB list/detail scraping adapter. |
| `lib/ingest/` | Stage 01 locks, cache writes, Notion code index, maker runner, run summaries. |
| `lib/enrichers/` | Notion helper, studio enrichment, Voyage AI enrichment placeholder/helper. |
| `stages/` | Seven stage implementations plus focused stage tests. |
| `tests/` | Additional `node --test` tests. |
| `tools/clean-notion.mjs` | Destructive Notion cleanup tool. Requires explicit Kenny approval. |

Runtime state:

| Path | Purpose |
|---|---|
| `~/.local/state/jav-manager/cache/` | Stage cache, summaries, snapshots, URL health, test artifacts. |
| `~/.local/state/jav-manager/logs/` | systemd wrapper logs and `jav-pipeline-latest.log`. |
| `~/.local/state/jav-manager/app-logs/` | App-level dated logs from `lib/shared.mjs`. |
| `~/.local/state/jav-manager/session/` | Scraper/browser session and cookie state. |
| `~/.local/state/jav-manager/ingest-index.json` | Rebuilt ingest index. |
| `~/.local/state/jav-manager/jav-pipeline.lock` | Wrapper-level lock for full pipeline. |
| `~/.local/state/jav-manager/alerts/` | Alert fingerprint markers. |

Path policy:

`lib/shared.mjs` routes app/config files to the app root and runtime files to
`~/.local/state/jav-manager`. Existing stage code may still call
`getSkillPath()`, but runtime paths are redirected to the state directory.

---

## 5. Configuration

Production config:

```text
/home/hungsvradmin/apps/jav-manager/.env
/home/hungsvradmin/apps/jav-manager/config.json
```

`.env` contains secrets and operational knobs:

| Area | Variables |
|---|---|
| Notion | `NOTION_TOKEN`, `NOTION_DATABASE_ID` |
| Telegram | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| FlareSolverr | `JAV_FLARESOLVERR_PORTS`, `JAV_FLARESOLVERR_CONTAINER_PREFIX`, timeout/cooldown/volume flags |
| Stage 01 | `JAV_INGEST_WORKERS`, item/page delay ranges |
| Stage 03 | `JAV_VERIFY_*` ports, concurrency, timeout, warmup, cooldown, delay, fail streak |
| Stage 07 | `JAV_CLEANUP_*_RETENTION_DAYS` |

Do not copy raw `.env` values into chat, reports, commits, docs, or prompts.

`config.json` contains:

- `favorites`: preferred actress names
- `makers`: JavDB maker names and URLs
- `aliases`: actress name aliases
- `makerAliases`: maker/studio aliases
- `filters`: maker-specific code prefixes to include

Maker-scope changes affect production scrape volume and Notion writes. Back up
`config.json` before changing it:

```bash
cp /home/hungsvradmin/apps/jav-manager/config.json \
  /home/hungsvradmin/apps/jav-manager/config.json.bak.$(date +%Y%m%d-%H%M%S)
```

---

## 6. Stage Responsibilities

### Stage 01 - Ingest

File: `stages/01-ingest.mjs`

Responsibilities:

- Acquire ingest lock under runtime cache.
- Initialize Notion helper and fetch existing codes for dedupe.
- Load `config.json` and optional `graveyard.json`.
- Restart FlareSolverr containers before scraping.
- Scrape configured maker pages through `FlareSolverrPool` and `JavDBScraper`.
- Apply filters, aliases, maker aliases, global dedupe, limits, and delays.
- Write per-item metadata and covers atomically.
- Rebuild ingest index and merged metadata for later stages.
- Write run summaries under `cache/ingest/runs/`.

Operational notes:

- Workers stick to assigned FlareSolverr ports.
- Sessions rotate between makers and can rotate mid-maker for large makers.
- Full production runs normally use `node --max-old-space-size=8192`.

### Stage 02 - Enrich

File: `stages/02-enrich.mjs`

Responsibilities:

- Abort if Stage 01 lock is active.
- Read per-item ingest cache.
- Batch-fetch existing Notion codes.
- Upload local covers to Notion direct file upload when available.
- Build Notion page properties.
- Create missing Notion pages.
- Write `cache/enrich-summary.json`.

Operational notes:

- Notion writes are production side effects.
- Cover upload can hit Notion rate limits; keep concurrency conservative.
- A successful empty Stage 01 run can produce a no-op Stage 02 summary.

### Stage 03 - Verify URL

File: `stages/03-verify-url.mjs`

Responsibilities:

- Maintain `cache/url-health.json`.
- Verify `URL no code` and `URL Chinese` for active Notion records.
- Build visible, retry, and bootstrap tasks.
- Use FlareSolverr to classify URLs as valid, invalid, or unknown.
- Apply Notion updates only when state-machine rules allow.

Safety model:

- Unknown results do not clear columns.
- Visible URLs require suspect -> invalid progression before clearing.
- Retry tasks can restore URLs.
- Invalid records back off and eventually become permanently invalid.

### Stage 04 - Rankings

File: `stages/04-rankings.mjs`

Responsibilities:

- Scrape MissAV hot ranking pages.
- Extract canonical codes.
- Query active Notion records.
- Diff ranking checkbox state.
- Patch `Daily Star`, `Weekly Star`, and `Monthly Star` checkboxes.
- Write ranking summary and audit/test artifacts.

Safety model:

- Healthy category: check-on and check-off allowed.
- Partial or suspicious category: check-on only; uncheck is blocked.
- Empty or broken category: skip category.
- Dry-run computes full diff but does not patch Notion.

### Stage 05 - Archive

File: `stages/05-archive.mjs`

Responsibilities:

- Tier 1: Active records older than 30 days become `Inactive [Archive]`.
- Tier 2: `Inactive [Archive]` records older than 365 days are archived/trash in Notion.

Important behaviour:

Very old Active records may move from Active to archived in the same run. This
is intentional because the original `Date` property is the sole threshold.

### Stage 06 - Notify

File: `stages/06-notify.mjs`

Responsibilities:

- Find new videos from ingest cache and recent Notion records.
- Diff daily, weekly, monthly, and triple-crown snapshots.
- Report permanently failed Stage 01 items.
- Send Telegram notification via HTML parse mode.
- Write `cache/notify-summary.json`.

Safety model:

- Telegram sends are externally visible production side effects.
- Dry-run logs the sections instead of sending.
- Snapshot files are protected from Stage 07 deletion.

### Stage 07 - Delete

File: `stages/07-delete.mjs`

Responsibilities:

- Delete transient ingest metadata, cover files, item files, and rebuildable indexes.
- Prune old run summaries, test artifacts, summary files, logs, and recycle bin.
- Clean empty runtime cache directories.
- Kill orphan Chromium processes owned by the current user.
- Preserve long-lived health, snapshot, and notified-code files.

Safety model:

- Direct module default is `dryRun=true`.
- Active ingest or verify locks abort cleanup.
- Files are soft-deleted to `.trash/` where applicable.
- Retention is controlled by `JAV_CLEANUP_*_RETENTION_DAYS`.

---

## 7. CLI and Commands

Package scripts:

```bash
npm run ingest
npm run enrich
npm run verify
npm run rankings
npm run archive
npm run delete
npm run all
npm test
```

Direct CLI:

```bash
cd /home/hungsvradmin/apps/jav-manager
node index.mjs <ingest|enrich|verify|rankings|archive|notify|delete|all> [options]
```

Common options:

```text
--dry-run
--verbose
--limit=<n>
--workers=<n>
--max-pages-per-maker=<n>
--visible-only
--retry-only
--concurrency=<n>
--max-retry-items=<n>
```

Preferred full pipeline wrapper:

```bash
/home/hungsvradmin/scripts/run-jav-pipeline.sh --check-only
/home/hungsvradmin/scripts/run-jav-pipeline.sh
```

The wrapper:

- checks dependencies and app/skill paths
- writes timestamped wrapper logs
- updates `jav-pipeline-latest.log`
- takes `~/.local/state/jav-manager/jav-pipeline.lock`
- runs the app from `/home/hungsvradmin/apps/jav-manager`
- uses a 5-hour timeout with TERM then kill-after 120 seconds
- exits with the real pipeline status for systemd

---

## 8. Scheduler and Monitoring

Active scheduler is user systemd, not OpenClaw cron.

Units:

```text
~/.config/systemd/user/jav-pipeline.service
~/.config/systemd/user/jav-pipeline.timer
~/.config/systemd/user/jav-pipeline-alert.service
~/.config/systemd/user/jav-pipeline-watchdog.service
~/.config/systemd/user/jav-pipeline-watchdog.timer
```

Full pipeline schedule:

```text
05:00, 11:00, 17:00, 23:00 HKT
```

Watchdog schedule:

```text
OnBootSec=10min
OnUnitActiveSec=10min
05:25, 11:25, 17:25, 23:25 HKT
```

Alert path:

```text
jav-pipeline.service OnFailure
  -> jav-pipeline-alert.service
  -> /home/hungsvradmin/scripts/jav-pipeline-alert.sh failure
  -> openclaw agent --channel telegram --to 6929449615 --deliver
```

Watchdog path:

```text
jav-pipeline-watchdog.timer
  -> /home/hungsvradmin/scripts/jav-pipeline-watchdog.sh
  -> /home/hungsvradmin/scripts/jav-pipeline-alert.sh missed|incomplete
```

Important monitoring behaviour:

- Watchdog verifies systemd state and recent journal markers.
- It also falls back to `jav-pipeline-latest.log` success markers to avoid false
  positives during systemd/journal timing gaps.
- Suspicious scraping/Cloudflare/error patterns can still trigger incomplete
  alerts even if the wrapper exited successfully.

Useful read-only commands:

```bash
systemctl --user show jav-pipeline.service -p ActiveState -p SubState -p Result -p ExecMainStatus --no-pager
systemctl --user list-timers jav-pipeline.timer jav-pipeline-watchdog.timer --all --no-pager
journalctl --user -u jav-pipeline.service -n 160 --no-pager
tail -160 /home/hungsvradmin/.local/state/jav-manager/logs/jav-pipeline-latest.log
```

---

## 9. Testing and Validation

Baseline validation for docs-only changes:

```bash
test -s CLAUDE.md && test -s README.md && test -s docs/PROJECT_CONTEXT.md
```

Baseline validation for app code changes:

```bash
cd /home/hungsvradmin/apps/jav-manager
node --check index.mjs
find lib stages tools -name '*.mjs' -print0 | xargs -0 -n1 node --check
npm test
```

Wrapper checks:

```bash
/home/hungsvradmin/scripts/run-jav-pipeline.sh --check-only
/home/hungsvradmin/scripts/jav-pipeline-alert.sh --check-only
/home/hungsvradmin/scripts/jav-pipeline-watchdog.sh --check-only
```

Systemd unit validation:

```bash
systemd-analyze --user verify ~/.config/systemd/user/jav-pipeline*.service ~/.config/systemd/user/jav-pipeline*.timer
```

Targeted dry-runs:

```bash
node index.mjs verify --dry-run --limit=5
node index.mjs rankings --dry-run
node index.mjs delete --dry-run
```

Do not run live full pipeline, Notion cleanup, Telegram sends, Docker lifecycle
changes, or systemd lifecycle changes just to validate unrelated edits.

---

## 10. Safety Boundaries

Always ask Kenny before:

- changing Notion database targets or property semantics
- changing Telegram bot/chat targets or sending real test messages
- expanding maker scope substantially
- changing archive/delete retention or behaviour
- running `tools/clean-notion.mjs`
- disabling cleanup
- changing scheduled run frequency or systemd unit lifecycle
- clearing FlareSolverr volumes
- running commands that delete production state outside dry-run mode

Medium/high-risk areas:

| Area | Why |
|---|---|
| Stage 02 | Creates Notion pages and uploads files. |
| Stage 03 | Can clear or restore Notion URL properties. |
| Stage 04 | Can patch ranking checkboxes at scale. |
| Stage 05 | Changes status and archives Notion pages. |
| Stage 06 | Sends user-visible Telegram messages. |
| Stage 07 | Deletes runtime files and can kill Chromium processes. |
| `post-pipeline.sh` | Recreates Docker containers. |
| systemd units/scripts | Controls production schedule and alerting. |

Low-risk areas:

- docs-only edits
- pure parser/helper tests
- `node --check`
- `npm test` when tests use mocks/temp directories
- wrapper `--check-only`

Rollback expectations:

- For config changes, keep timestamped `.bak.*` files.
- For code changes, keep diff small and run focused validation.
- For scheduler changes, validate with `systemd-analyze --user verify`, reload
  only when intended, and re-check timers afterward.
- For failed production pipeline diagnosis, report `exit=<code>` and relevant
  latest-log/journal tail.

---

## 11. Dev-Workflow Policy

Use `docs/PROJECT_CONTEXT.md` as the durable project knowledge base for
`dev-workflow`. Do not use it as a task log.

Use `bugfix-light` for:

- small docs updates
- narrow tests
- low-risk parser/helper fixes with focused validation

Use `full-workflow` for:

- any production stage behaviour change
- Notion write logic
- Telegram formatting or send behaviour
- FlareSolverr pool/container lifecycle
- archive/delete/cleanup behaviour
- systemd wrappers, timers, watchdogs, or alert path
- broad refactors

Update this file when a task changes or confirms durable facts about:

- architecture
- stage responsibilities
- runtime/state paths
- environment variables
- scheduler behaviour
- test strategy
- production safety boundaries
- known integration constraints

Task history should go under `docs/WORKLOG.md` or
`docs/dev-workflow/tasks/<task>/`, not in this file.
