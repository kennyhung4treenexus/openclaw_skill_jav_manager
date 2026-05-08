/**
 * Stage 2: Enrich - Insert metadata into Notion DB
 *
 * Responsibilities:
 * 1. Read metadata.json from cache/ingest/
 * 2. Batch-fetch existing codes from Notion to avoid N+1 queries
 * 3. For each item, check if actress is in config.favorites
 * 4. Upload local cover to Notion (Direct Upload method)
 * 5. Create page with all properties including Cover
 * 6. Worker queue concurrency for throughput
 * 7. Ingest lock guard to prevent race with Stage 1
 *
 * Notion File Upload Flow (Direct Upload):
 * 1. POST /v1/file_uploads - Create upload object, get id + upload_url
 * 2. POST /v1/file_uploads/{id}/send - Send file content (multipart/form-data)
 * 3. Use file_upload id in page properties
 */

import { getSkillPath, readJson, writeJsonAtomic, log, sleep, notionRetry } from '../lib/shared.mjs';
import { Client } from '@notionhq/client';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { getIngestLockPath } from '../lib/ingest/ingest-lock.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NOTION_VERSION = '2022-06-28';
const RATE_LIMIT_DELAY_MS = 300;

function getLatestIngestSummary() {
  const runsDir = getSkillPath('cache/ingest/runs');
  if (!existsSync(runsDir)) return null;

  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse();

  for (const file of files) {
    try {
      const summary = readJson(join(runsDir, file));
      if (summary?.runId) return summary;
    } catch (error) {
      log(`[enrich] Failed to read ingest run summary ${file}: ${error.message}`, 'warn');
    }
  }

  return null;
}

function isSuccessfulEmptyIngest(summary) {
  return !!summary?.finishedAt &&
    Number(summary.itemsExtracted || 0) === 0 &&
    Number(summary.errors || 0) === 0;
}

function buildNoOpSummary(reason, latestIngestSummary = null) {
  return {
    stage: '02-enrich',
    status: 'completed',
    processed: 0,
    created: 0,
    skipped: [],
    errors: 0,
    results: [],
    note: reason,
    latestIngestRunId: latestIngestSummary?.runId,
  };
}

// ---------------------------------------------------------------------------
// Worker queue runner (same pattern as Stage 01)
// ---------------------------------------------------------------------------
async function runWorkers({ queue, concurrency, workerFn }) {
  if (queue.length === 0) return [];
  let index = 0;
  const results = [];

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= queue.length) return;
      try {
        results[i] = await workerFn(queue[i], i);
      } catch (err) {
        results[i] = { error: err.message, item: queue[i] };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, () => worker())
  );
  return results;
}

// ---------------------------------------------------------------------------
// Batch-fetch all existing codes from Notion (avoid N+1 queries)
// ---------------------------------------------------------------------------
async function fetchAllExistingCodes(notion, databaseId) {
  const existing = new Map(); // code → pageId
  let cursor;

  do {
    const resp = await notion.databases.query({
      database_id: databaseId,
      page_size: 100,
      start_cursor: cursor,
    });
    for (const page of resp.results) {
      const code = page.properties?.Code?.rich_text?.[0]?.plain_text?.trim()?.toUpperCase();
      if (code) existing.set(code, page.id);
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  return existing;
}

// ---------------------------------------------------------------------------
// Upload cover to Notion
// ---------------------------------------------------------------------------
async function uploadFileToNotion(filePath, code) {
  const token = process.env.NOTION_TOKEN;
  const apiBase = 'https://api.notion.com/v1';

  // Step 1: Create file upload object
  const createResponse = await notionRetry(async () => {
    const resp = await fetch(`${apiBase}/file_uploads`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION
      },
      body: JSON.stringify({
        filename: `${code}.jpg`,
        content_type: 'image/jpeg'
      })
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`File upload creation failed (${resp.status}): ${text}`);
    }
    return resp.json();
  }, `cover-create-${code}`, 3);

  const uploadId = createResponse.id;

  // Step 2: Send file content
  const fileBuffer = readFileSync(filePath);
  const formData = new FormData();
  formData.append('file', new Blob([fileBuffer], { type: 'image/jpeg' }), `${code}.jpg`);

  await notionRetry(async () => {
    const resp = await fetch(`${apiBase}/file_uploads/${uploadId}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION
      },
      body: formData
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`File send failed (${resp.status}): ${text}`);
    }
    return resp.json();
  }, `cover-send-${code}`, 3);

  return uploadId;
}

// ---------------------------------------------------------------------------
// Build Notion properties for a single item
// ---------------------------------------------------------------------------
function buildProperties(code, metadata, isFavorite, fileUploadId) {
  const props = {
    'Name': {
      title: [{ text: { content: metadata.cleanTitle || metadata.title || code } }]
    },
    'Code': {
      rich_text: [{ text: { content: code } }]
    },
    'Actress': {
      rich_text: [{ text: { content: (metadata.actresses || []).join(', ') } }]
    },
    'Date': metadata.date ? { date: { start: metadata.date } } : null,
    'Maker': {
      rich_text: [{ text: { content: metadata.maker || '' } }]
    },
    'Status': {
      select: { name: 'Active' }
    },
    'Favorite': {
      checkbox: isFavorite
    },
    'Daily Star': { checkbox: false },
    'Weekly Star': { checkbox: false },
    'Monthly Star': { checkbox: false },
    'URL': { url: `https://missav.ai/${code}` },
    'URL no code': { url: null },
    'URL Chinese': { url: null }
  };

  // Filter out null properties
  for (const [key, val] of Object.entries(props)) {
    if (val === null) delete props[key];
  }

  return props;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const { dryRun = false, verbose = false, limit = 0, concurrency = 3 } = options;

  log(`Starting Stage 2: Enrich — dryRun=${dryRun} concurrency=${concurrency} limit=${limit}`, 'info');

  // ── Lock guard: check if Stage 1 (ingest) is running ───────────────
  const ingestLockPath = getIngestLockPath();
  if (existsSync(ingestLockPath)) {
    try {
      const lock = readJson(ingestLockPath);
      if (lock && lock.pid && lock.startedAt) {
        const age = Date.now() - lock.startedAt;
        if (age < 6 * 60 * 60 * 1000) {
          log(`[enrich] Ingest lock active (pid=${lock.pid}, age=${Math.round(age / 1000)}s) — aborting to avoid race`, 'warn');
          return {
            stage: '02-enrich', status: 'skipped',
            reason: 'ingest lock held',
          };
        }
      }
    } catch (_) {}
  }

  // ── Init Notion ───────────────────────────────────────────────
  const notionToken = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_DATABASE_ID;

  if (!notionToken || !databaseId) {
    return {
      stage: '02-enrich', status: 'error',
      error: 'NOTION_TOKEN or NOTION_DATABASE_ID not configured',
    };
  }

  const notion = new Client({ auth: notionToken });

  // ── Load config ───────────────────────────────────────────────
  const config = readJson(getSkillPath('config.json'));
  const favorites = config.favorites || [];
  log(`[enrich] Loaded ${favorites.length} favorites from config`, 'info');

  // ── Load metadata from Stage 1 (individual item files) ────────
  const itemsDir = getSkillPath('cache/ingest/items');
  const latestIngestSummary = getLatestIngestSummary();
  let items = [];

  try {
    const files = readdirSync(itemsDir).filter(f => f.endsWith('.json'));

    if (files.length === 0 && isSuccessfulEmptyIngest(latestIngestSummary)) {
      const reason = `Latest Stage 1 run ${latestIngestSummary.runId} extracted 0 items; nothing to enrich.`;
      log(`[enrich] ${reason}`, 'warn');
      const summary = buildNoOpSummary(reason, latestIngestSummary);
      if (!dryRun) writeJsonAtomic(getSkillPath('cache/enrich-summary.json'), summary);
      return summary;
    }

    items = files.map(f => JSON.parse(readFileSync(join(itemsDir, f), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT' && isSuccessfulEmptyIngest(latestIngestSummary)) {
      const reason = `Latest Stage 1 run ${latestIngestSummary.runId} extracted 0 items; cache/ingest/items is absent, so Stage 2 has no work.`;
      log(`[enrich] ${reason}`, 'warn');
      const summary = buildNoOpSummary(reason, latestIngestSummary);
      if (!dryRun) writeJsonAtomic(getSkillPath('cache/enrich-summary.json'), summary);
      return summary;
    }

    log(`[enrich] Failed to read ingest items: ${error.message}`, 'error');
    return {
      stage: '02-enrich', status: 'error',
      error: 'No ingest items found. Run Stage 1 first.',
    };
  }

  log(`[enrich] Found ${items.length} items in cache/ingest/items/`, 'info');

  // Apply limit
  if (limit > 0 && limit < items.length) {
    items = items.slice(0, limit);
    log(`[enrich] Limited to ${limit} items`, 'info');
  }

  // ── Batch-fetch existing codes from Notion ─────────────────────
  let existingCodes;
  try {
    existingCodes = dryRun ? new Map() : await fetchAllExistingCodes(notion, databaseId);
    log(`[enrich] Batch-fetched ${existingCodes.size} existing codes from Notion`, 'info');
  } catch (err) {
    log(`[enrich] Failed to fetch existing codes: ${err.message}`, 'error');
    return { stage: '02-enrich', status: 'error', error: err.message };
  }

  // ── Build work queue ──────────────────────────────────────────
  const workQueue = [];
  const skipped = [];

  for (const item of items) {
    const code = item.code?.toUpperCase?.();
    if (!code) continue;

    if (existingCodes.has(code)) {
      skipped.push({ code, reason: 'already_exists' });
      continue;
    }

    workQueue.push(item);
  }

  log(`[enrich] Queue: ${workQueue.length} items to create, ${skipped.length} already exist`, 'info');

  if (workQueue.length === 0) {
    const summary = {
      stage: '02-enrich',
      status: 'completed',
      processed: items.length,
      created: 0,
      skipped: skipped.length,
      errors: 0,
      skipped,
    };
    writeJsonAtomic(getSkillPath('cache/enrich-summary.json'), summary);
    return summary;
  }

  // ── Worker processing ─────────────────────────────────────────
  const results = await runWorkers({
    queue: workQueue,
    concurrency: Math.min(concurrency, workQueue.length),
    workerFn: async (item) => {
      const code = item.code.toUpperCase();
      const metadata = item.metadata || item;

      // Check if actress is favorite
      const actresses = metadata.actresses || [];
      const isFavorite = actresses.some(a => favorites.includes(a));

      // Cover upload
      const coverPath = getSkillPath(`cache/ingest/covers/${code}.jpg`);
      let fileUploadId = null;

      if (existsSync(coverPath)) {
        if (dryRun) {
          log(`[enrich] [DRY] Would upload cover for ${code}.jpg`, 'info');
        } else {
          try {
            fileUploadId = await uploadFileToNotion(coverPath, code);
            log(`[enrich] Uploaded cover: ${code}.jpg -> ${fileUploadId}`, 'info');
          } catch (uploadError) {
            log(`[enrich] Cover upload failed for ${code}: ${uploadError.message}`, 'warn');
          }
        }
      } else {
        log(`[enrich] No local cover for ${code}, skipping`, 'info');
      }

      // Build properties
      const properties = buildProperties(code, metadata, isFavorite, fileUploadId);

      // Create page
      if (dryRun) {
        log(`[enrich] [DRY] Would create Notion page for ${code}`, 'info');
        return { code, action: 'created (dry-run)', isFavorite, coverUploaded: !!fileUploadId };
      }

      const pageData = {
        parent: { database_id: databaseId },
        properties: {
          ...properties,
          'Cover': fileUploadId ? {
            files: [{
              type: 'file_upload',
              file_upload: { id: fileUploadId },
              name: `${code}.jpg`
            }]
          } : { files: [] }
        },
        cover: fileUploadId ? {
          type: 'file_upload',
          file_upload: { id: fileUploadId }
        } : null
      };

      const newPage = await notionRetry(
        () => notion.pages.create(pageData),
        `create-${code}`, 3
      );

      log(`[enrich] Created Notion page: ${code}`, 'info');

      // Rate limit
      await sleep(RATE_LIMIT_DELAY_MS);

      return {
        code,
        pageId: newPage.id,
        action: 'created',
        isFavorite,
        coverUploaded: !!fileUploadId,
      };
    },
  });

  // ── Collect results ───────────────────────────────────────────
  const errors = [];

  for (const r of results) {
    if (r.error) {
      errors.push({ code: r.item?.code || '?', error: r.error });
    }
  }

  const created = results.filter(r => !r.error);

  // ── Summary ───────────────────────────────────────────────────
  const summary = {
    stage: '02-enrich',
    status: 'completed',
    processed: items.length,
    created: created.length,
    skipped: skipped.length,
    errors: errors.length,
    results: created,
    skipped,
    errorDetails: errors.length > 0 ? errors : undefined,
  };

  log(`[enrich] Done — ${created.length} created, ${skipped.length} skipped, ${errors.length} errors`, 'info');

  if (!dryRun) {
    writeJsonAtomic(getSkillPath('cache/enrich-summary.json'), summary);
  }

  return summary;
}

export const config = {
  name: '02-enrich',
  description: 'Insert metadata into Notion DB',
  dependencies: ['01-ingest'],
};
