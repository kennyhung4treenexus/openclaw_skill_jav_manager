/**
 * Stage 5: Archive — Two-Tier Retention Model (Date-based)
 *
 * Tier 1 (>30 days old, Active):
 *   Set Status = 'Inactive [Archive]'
 *
 * Tier 2 (>365 days old, Inactive [Archive]):
 *   Archive page (archived: true → Notion trash)
 *
 * Design note: both tiers use the original Date property as the sole threshold.
 * A very old Active record may go from Active → archived:true in the same run.
 * This is by design — the archive period is the gap between 30d and 365d.
 *
 * Tech stack: Node.js, @notionhq/client, date-fns
 */

import { Client } from '@notionhq/client';
import { format, sub } from 'date-fns';
import { log, notionRetry } from '../lib/shared.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const INACTIVE_THRESHOLD_DAYS = 30;    // → set Status = 'Inactive [Archive]'
const ARCHIVE_THRESHOLD_DAYS  = 365;   // → archived: true (Notion trash)
const RATE_LIMIT_DELAY_MS     = 300;
const NOTION_PAGE_SIZE        = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Build a "before" date string for Notion filter. */
function cutDate(daysAgo) {
  return format(sub(new Date(), { days: daysAgo }), 'yyyy-MM-dd');
}

/** Extract Code from a Notion page (for logging). */
function extractCode(page) {
  return page.properties?.Code?.rich_text?.[0]?.plain_text?.trim()?.toUpperCase() ?? page.id;
}

/**
 * Paginated Notion database query helper.
 * Returns all matching records (follows next_cursor automatically).
 */
async function queryAll(notion, databaseId, filter, pageSize = NOTION_PAGE_SIZE) {
  const records = [];
  let cursor;

  do {
    const resp = await notion.databases.query({
      database_id: databaseId,
      filter,
      start_cursor: cursor,
      page_size: pageSize,
    });

    records.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return records;
}

// ---------------------------------------------------------------------------
// Tier 1: Set Inactive [Archive] for Active records > 30 days old
// ---------------------------------------------------------------------------
async function tier1_inactive(notion, databaseId, dryRun) {
  const cutD = cutDate(INACTIVE_THRESHOLD_DAYS);
  log(`[archive:tier1] Cut-off: ${cutD} (${INACTIVE_THRESHOLD_DAYS} days ago) — Active → Inactive [Archive]`, 'info');

  const records = await queryAll(notion, databaseId, {
    property: 'Date',
    date: { before: cutD },
  });

  // Only touch Active records
  const activeRecords = records.filter(r =>
    r.properties?.Status?.select?.name === 'Active'
  );

  log(`[archive:tier1] Found ${records.length} old records, ${activeRecords.length} are Active`, 'info');

  if (activeRecords.length === 0) return { candidates: 0, updated: 0, errors: 0 };

  let updated = 0, errors = 0;

  for (const record of activeRecords) {
    const code = extractCode(record);

    try {
      if (dryRun) {
        log(`[archive:tier1] DRY RUN: would set Status=Inactive [Archive] for ${code}`, 'info');
      } else {
        await notionRetry(
          () => notion.pages.update({
            page_id: record.id,
            properties: {
              Status: { select: { name: 'Inactive [Archive]' } },
            },
          }),
          `tier1: ${code}`
        );
        log(`[archive:tier1] ${code}: Status → Inactive [Archive]`, 'info');
      }
      updated++;
    } catch (err) {
      log(`[archive:tier1] Failed to update ${code}: ${err.message}`, 'error');
      errors++;
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return { candidates: activeRecords.length, updated, errors };
}

// ---------------------------------------------------------------------------
// Tier 2: Archive (trash) records whose Date > 365 days ago
// Must be Inactive [Archive] status.
// ---------------------------------------------------------------------------
async function tier2_archive(notion, databaseId, dryRun) {
  const cutD = cutDate(ARCHIVE_THRESHOLD_DAYS);
  log(`[archive:tier2] Cut-off: ${cutD} (${ARCHIVE_THRESHOLD_DAYS} days ago) — Inactive [Archive] + Date → archive/trash`, 'info');

  const records = await queryAll(notion, databaseId, {
    and: [
      { property: 'Status', select: { equals: 'Inactive [Archive]' } },
      { property: 'Date',   date: { before: cutD } },
    ],
  });

  log(`[archive:tier2] Found ${records.length} records to archive/trash`, 'info');

  if (records.length === 0) return { candidates: 0, archived: 0, errors: 0 };

  let archived = 0, errors = 0;

  for (const record of records) {
    const code = extractCode(record);
    const recordDate = record.properties?.Date?.date?.start ?? '?';

    try {
      if (dryRun) {
        log(`[archive:tier2] DRY RUN: would archive/trash ${code} (Date=${recordDate})`, 'info');
      } else {
        await notionRetry(
          () => notion.pages.update({
            page_id: record.id,
            archived: true,
          }),
          `tier2: ${code}`
        );
        log(`[archive:tier2] Archived ${code} (Date=${recordDate})`, 'info');
      }
      archived++;
    } catch (err) {
      log(`[archive:tier2] Failed to archive ${code}: ${err.message}`, 'error');
      errors++;
    }

    await sleep(RATE_LIMIT_DELAY_MS);
  }

  return { candidates: records.length, archived, errors };
}

// ---------------------------------------------------------------------------
// Main run
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const { dryRun = false, client: injectedClient, databaseId: injectedDb } = options;

  log(`[archive] Starting — dryRun=${dryRun}`, 'info');

  const notion = injectedClient ?? new Client({ auth: process.env.NOTION_TOKEN });
  const databaseId = injectedDb ?? process.env.NOTION_DATABASE_ID;

  if (!databaseId) throw new Error('NOTION_DATABASE_ID not configured');

  // ── Tier 1: >30 days Active → Inactive [Archive] ──
  const t1 = await tier1_inactive(notion, databaseId, dryRun);
  log(`[archive:tier1] Done — candidates=${t1.candidates} updated=${t1.updated} errors=${t1.errors}`, 'info');

  // ── Tier 2: >365 days + Inactive [Archive] → archive/trash ──
  const t2 = await tier2_archive(notion, databaseId, dryRun);
  log(`[archive:tier2] Done — candidates=${t2.candidates} archived=${t2.archived} errors=${t2.errors}`, 'info');

  const result = {
    stage: '05-archive',
    status: 'completed',
    thresholdDays: INACTIVE_THRESHOLD_DAYS,
    archiveDays: ARCHIVE_THRESHOLD_DAYS,
    tier1Candidates: t1.candidates,
    tier1Updated: t1.updated,
    tier2Candidates: t2.candidates,
    tier2Archived: t2.archived,
    errors: t1.errors + t2.errors,
    dryRun: !!dryRun,
  };

  log(
    `[archive] Done — tier1=${result.tier1Updated}/${result.tier1Candidates} tier2=${result.tier2Archived}/${result.tier2Candidates} errors=${result.errors}`,
    'info'
  );

  return result;
}

// ---------------------------------------------------------------------------
// Module config
// ---------------------------------------------------------------------------
export const config = {
  name: '05-archive',
  description: 'Two-tier archive: >30d Active → Inactive [Archive]; >365d Inactive [Archive] → archive/trash.',
  dependencies: [],
};
