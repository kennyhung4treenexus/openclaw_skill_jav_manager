---
name: jav-manager
description: Manages JAV sync pipelines and metadata control files.
---

# jav-manager

## Scope
- Design, edit, refactor, and review a 7-stage JAV sync pipeline.
- Safely maintain canonical JSON control files located in the skill root.
- Prefer script-based extraction over AI extraction for JavDB metadata.
- Node.js-first implementation; Python only for narrow, clearly-justified utilities.

## File Structure
```
skills/jav-manager/
├── SKILL.md                  # This file
├── index.mjs                 # CLI orchestrator (node index.mjs <command>)
├── .env.example              # All documented environment variables
├── ingest-index.json         # Ingest cache index (code→maker mapping)
│
├── stages/                   # 7-stage pipeline
│   ├── 01-ingest.mjs         # Collect raw data from JavDB
│   ├── 02-enrich.mjs         # Batch-deduplicate & enhance metadata → Notion
│   ├── 03-verify-url.mjs     # Verify missav.ai URLs in Notion
│   ├── 04-rankings.mjs       # Scrape MissAV rankings → Notion curation
│   ├── 05-archive.mjs        # Date-based two-tier retention (30d / 365d)
│   ├── 06-notify.mjs         # Telegram reports (new videos + triple crowns)
│   ├── 07-delete.mjs         # Safe resource purge with recycle bin
│   ├── test-05-archive.mjs
│   ├── test-06-notify.mjs
│   └── test-07-delete.mjs
│
└── lib/
    ├── shared.mjs            # Common utilities: sleep, parseFlaresolverrPorts,
    │                         #   notionRetry, readJson/writeJson, logging
    ├── net/
    │   └── flaresolverr-pool.mjs  # FlareSolverrPool class (shared by 01/03/04)
    ├── ingest/
    │   └── item-store.mjs    # Per-item atomic cache for ingest
    ├── scrapers/             # JavDB / MissAV scraper modules
    └── enrichers/            # Metadata enrichment modules
```

## Staged Architecture

| Stage | File | Core Function |
|-------|------|---------------|
| 1 | `01-ingest.mjs` | Scrape JavDB makers via FlareSolverrPool worker queue. Per-item atomic caching, global dedupe, HKT schedule slot. Lock-guarded (`ingest.lock`). |
| 2 | `02-enrich.mjs` | Batch fetch existing Notion codes (no N+1 queries). Worker queue with configurable concurrency. Lock-guarded against ingest. Cover image upload with retry. |
| 3 | `03-verify-url.mjs` | Three-tier task system (visible / retry / bootstrap). State machine: suspect→invalid requires two consecutive failures. FlareSolverrPool with cooldown + failover. |
| 4 | `04-rankings.mjs` | Scrape MissAV daily/weekly/monthly stars + actresses. Per-page health checks (MIN_CODES_PER_PAGE, suspicious detection). Per-category allowUncheck safety gate. Diff-based Notion patching. |
| 5 | `05-archive.mjs` | Pure Date-based two-tier retention. Tier 1: Date >30d + Active → Inactive [Archive]. Tier 2: Date >365d + Inactive → archived:true. Uses existing `Date` + `Status` Notion properties only. No schema change required. |
| 6 | `06-notify.mjs` | Telegram report: new videos (ingest cache + Notion recent), triple-crown tracking (daily∩weekly∩monthly), snapshot-based diffing to avoid repeat notifications. MarkdownV2 with plaintext fallback. |
| 7 | `07-delete.mjs` | Recycle bin (.trash/) with configurable retention. Lock-guarded (ingest.lock + verify-url.lock). Protected files never deleted. Orphan Chromium cleanup. Default dry-run. |

## Shared Architecture Patterns

### FlareSolverrPool (`lib/net/flaresolverr-pool.mjs`)
Single shared pool class used by stages 01, 03, and 04. Features:
- Health tracking + per-instance cooldown on failure
- Round-robin dispatch with automatic failover
- Configurable via `JAV_FLARESOLVERR_PORTS` (comma-separated)
- Stage 03 override: `JAV_VERIFY_FLARESOLVERR_PORTS` (falls back to `JAV_FLARESOLVERR_PORTS`)

### Lock Guards
- `ingest.lock` — Stage 01 (write) → Stages 02, 07 (check)
- `verify-url.lock` — Stage 03 (write) → Stage 07 (check)
- Prevents overlapping runs that would corrupt shared state.

### Dry-Run Support
All stages support `--dry-run` (via `options.dryRun`). In dry-run mode:
- Stages 01-04: Read-only, report what would change, no Notion writes.
- Stage 05: Calculate candidates, no property patches.
- Stage 07: Default mode; requires explicit opt-in to actually delete.

### Notion Retry (`notionRetry` in `lib/shared.mjs`)
Wraps Notion API calls with configurable retry count and delay. Used by stages 02, 03, 04, 06 to handle transient API failures.

### Run Summaries
Every stage returns a summary object with stage-specific keys (e.g., `itemsProcessed`, `tier1Updated`, `dryRun`, `errors`). Summaries are persisted to `logs/` for debugging and audit.

## Configuration

All configuration is via environment variables. See `.env.example` for the full list.

**Required:**
- `NOTION_TOKEN` — Notion integration token
- `NOTION_DATABASE_ID` — Target database UUID
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` — For Stage 06

**Key optional:**
- `JAV_FLARESOLVERR_PORTS` — Comma-separated FlareSolverr ports (default: `8191`)
- `JAV_INGEST_WORKERS` — Stage 01 concurrency (default: `1`)
- `JAV_VERIFY_CONCURRENCY` — Stage 03 concurrency (default: `4`)
- `JAV_VERIFY_FLARESOLVERR_PORTS` — Stage 03 override ports
- `JAV_CLEANUP_TRASH_RETENTION_DAYS` — Stage 07 trash retention (default: `7`)

## CLI Usage

```bash
# Via index.mjs orchestrator
node index.mjs <ingest|enrich|verify|rankings|archive|notify|delete|all> [--dry-run] [--verbose]

# Via direct stage invocation
node stages/01-ingest.mjs
node stages/05-archive.mjs --dry-run
```

## Safety Rules
- Canonical JSON safety: no accidental reset or overwrite; no silent corruption.
- Stdout must remain concise; verbose logs go to `logs/`.
- Notion cover handling: do not store external cover URLs directly; use official upload flow.
- **Default dry-run**: Stage 07 always defaults to dry-run; must explicitly opt in to delete.
- **Lock guards**: Stages that mutate shared cache or Notion state check sibling-stage locks before running.
- **Recycle bin**: Deleted files go to `.trash/` first; retention is configurable (`JAV_CLEANUP_TRASH_RETENTION_DAYS`).

## Non-Goals
- It does not modify legacy JSON under `/home/hungsvradmin/scripts/jav-sync/`.
- It does not guess Notion payloads or endpoints.
- It does not run the full pipeline automatically as a single command by default (each stage is independent by design; cron scheduling is the user's responsibility).
