/**
 * Stage 03: verify-url (v3 — hardened)
 *
 * Steady-state monitoring + hidden-retry system for two volatile Notion columns:
 *   - "URL no code"
 *   - "URL Chinese"
 *
 * Design:
 * - Three-tier task system: visible / retry / bootstrap (always enabled)
 * - Cache-driven state machine with suspect→invalid→permanentlyInvalid cascade
 * - FlareSolverr worker pool for concurrency
 * - Lock guard to prevent overlapping cron runs
 * - Bootstrap always runs to seed empty URL columns (no flag required)
 * - Positive + negative signal detection for page evaluation
 * - per-property summary counters
 *
 * State machine:
 *   bootstrap:  empty column → check expected URL
 *     valid   → set Notion URL, clear cache slot
 *     invalid → mark invalid, schedule retry
 *     unknown → mark unknown, retry next schedule slot
 *   visible:   URL shown in Notion → re-check
 *     valid   → clear cache slot (no Notion change)
 *     invalid → suspect (first fail); invalid (second consecutive fail) → clear Notion
 *     unknown → don't touch Notion, retry later
 *   retry:     previously invalid → re-check
 *     valid   → restore Notion URL
 *     invalid → increment failCount, schedule backoff
 *     failCount >= MAX_RETRIES → permanentlyInvalid (no more retries)
 *
 * Env vars (JAV_VERIFY_ prefix):
 *   JAV_VERIFY_FLARESOLVERR_PORTS        - Comma-separated port list (default: 8191-8196)
 *   JAV_VERIFY_CONCURRENCY               - Max concurrent workers
 *   JAV_VERIFY_FLARESOLVERR_TIMEOUT_MS   - FlareSolverr request timeout
 *   JAV_VERIFY_FLARESOLVERR_COOLDOWN_MS  - Cooldown after failure
 *   JAV_VERIFY_MAX_RETRIES               - Max retries before permanentlyInvalid (default: 5)
 *   JAV_VERIFY_INVALID_BACKOFF_1         - Backoff 1st fail  (default: 86400000 = 24h)
 *   JAV_VERIFY_INVALID_BACKOFF_2         - Backoff 2nd fail  (default: 86400000 = 24h)
 *   JAV_VERIFY_INVALID_BACKOFF_3         - Backoff 3rd fail  (default: 259200000 = 72h)
 *   JAV_VERIFY_INVALID_BACKOFF_4_PLUS    - Backoff 4+ fails  (default: 604800000 = 7d)
 */

import { log, getSkillPath, writeJsonAtomic, readJson, sleep, notionRetry } from '../lib/shared.mjs';
import { FlareSolverrPool } from '../lib/net/flaresolverr-pool.mjs';
import { Client } from '@notionhq/client';
import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const NOTION_PATCH_DELAY = 300;

const BACKOFF_1    = parseInt(process.env.JAV_VERIFY_INVALID_BACKOFF_1      || '86400000', 10);    // 24h
const BACKOFF_2    = parseInt(process.env.JAV_VERIFY_INVALID_BACKOFF_2      || '86400000', 10);    // 24h
const BACKOFF_3    = parseInt(process.env.JAV_VERIFY_INVALID_BACKOFF_3      || '259200000', 10);   // 72h
const BACKOFF_4P   = parseInt(process.env.JAV_VERIFY_INVALID_BACKOFF_4_PLUS || '604800000', 10);   // 7d

function invalidBackoffMs(failCount) {
  if (failCount <= 1) return BACKOFF_1;
  if (failCount === 2) return BACKOFF_2;
  if (failCount === 3) return BACKOFF_3;
  return BACKOFF_4P;
}

function parseFlaresolverrPorts(raw) {
  const fallback = [8191, 8192, 8193, 8194, 8195, 8196];
  if (!raw?.trim()) return fallback;
  const ports = [...new Set(
    raw.split(',')
      .map(p => parseInt(p.trim(), 10))
      .filter(Number.isInteger)
      .filter(p => p > 0 && p <= 65535)
  )];
  return ports.length > 0 ? ports : fallback;
}

const FLARESOLVERR_PORTS = parseFlaresolverrPorts(
  process.env.JAV_VERIFY_FLARESOLVERR_PORTS || process.env.JAVVERIFY_FLARESOLVERR_PORTS
);
const DEFAULT_CONCURRENCY = parseInt(
  process.env.JAV_VERIFY_CONCURRENCY || process.env.JAVVERIFY_CONCURRENCY
  || String(Math.min(FLARESOLVERR_PORTS.length, 6)), 10
);
const FS_TIMEOUT   = parseInt(process.env.JAV_VERIFY_FLARESOLVERR_TIMEOUT_MS  || process.env.JAVVERIFY_FLARESOLVERR_TIMEOUT_MS  || '60000', 10);
const FS_WARMUP    = parseInt(process.env.JAV_VERIFY_FLARESOLVERR_WARMUP_MS     || '120000', 10);
const FS_COOLDOWN  = parseInt(process.env.JAV_VERIFY_FLARESOLVERR_COOLDOWN_MS || process.env.JAVVERIFY_FLARESOLVERR_COOLDOWN_MS || '300000', 10);
const FS_DELAY     = parseInt(process.env.JAV_VERIFY_FLARESOLVERR_DELAY_MS     || '750', 10);
const FS_FAILSTREAK= parseInt(process.env.JAV_VERIFY_FLARESOLVERR_FAIL_STREAK || '5', 10);
const MAX_RETRIES  = parseInt(process.env.JAV_VERIFY_MAX_RETRIES || '5', 10);

// ---------------------------------------------------------------------------
// Volatile slot definitions
// ---------------------------------------------------------------------------
const VOLATILE_SLOTS = [
  {
    slot: 'noCode',
    propName: 'URL no code',
    buildExpectedUrl: (code) => `https://missav.ai/${code}-uncensored-leak/`,
  },
  {
    slot: 'chinese',
    propName: 'URL Chinese',
    buildExpectedUrl: (code) => `https://missav.ai/${code}-chinese-subtitle/`,
  },
];

// ---------------------------------------------------------------------------
// Next HKT schedule slot (05:00 / 11:00 / 17:00 / 23:00)
// ---------------------------------------------------------------------------
const SCHEDULE_HOURS_HKT = [5, 11, 17, 23];

function nextScheduleSlotMs(nowMs) {
  const now = new Date(nowMs);
  const hktHour = (now.getUTCHours() + 8) % 24;

  // Same day: next slot after current HKT hour
  for (const h of SCHEDULE_HOURS_HKT) {
    if (h > hktHour) {
      const slot = new Date(now);
      slot.setUTCHours(h - 8, 0, 0, 0);
      return slot.getTime();
    }
  }

  // All slots passed → first slot tomorrow
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(SCHEDULE_HOURS_HKT[0] - 8, 0, 0, 0);
  return tomorrow.getTime();
}

// ---------------------------------------------------------------------------
// Page evaluation — dual signal detection
// ---------------------------------------------------------------------------
const NOT_FOUND_PATTERNS = [
  '找不到頁面', 'Page not found', '頁面未找到',
  'ページが見つかりません',
];

const POSITIVE_SIGNAL_PATTERNS = [
  '<video', '<video ', 'class="player"', 'data-video-id=',
  'class="vjs-', 'jwplayer', 'class="video-js',
];

function evaluatePage(html) {
  const lower = html.toLowerCase();

  // Positive signal → definitely valid
  if (POSITIVE_SIGNAL_PATTERNS.some(p => lower.includes(p))) return true;

  // Negative signal → definitely invalid
  if (lower.includes('<title>404') || lower.includes('<h1>404') || lower.includes('<h2>404')) return false;
  if (NOT_FOUND_PATTERNS.some(p => html.includes(p))) return false;

  // Ambiguous — no video player, no error page
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------
function getLockPath() {
  return join(getSkillPath('cache'), 'verify-url.lock');
}

function acquireLock(lockPath, staleMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  if (existsSync(lockPath)) {
    try {
      const content = readJson(lockPath);
      if (content && content.pid && content.startedAt && (now - content.startedAt) < staleMs) {
        log(`[verify-url] Lock exists (pid=${content.pid}, age=${((now - content.startedAt) / 1000) | 0}s) — skipping`, 'info');
        return false;
      }
    } catch (_) {}
  }
  writeJsonAtomic(lockPath, { pid: process.pid, startedAt: now });
  return true;
}

function releaseLock(lockPath) {
  try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Health cache
// ---------------------------------------------------------------------------
const HEALTH_CACHE_PATH = () => join(getSkillPath('cache'), 'url-health.json');

function loadHealthCache() {
  try {
    const data = readJson(HEALTH_CACHE_PATH());
    if (!data || typeof data !== 'object') return { version: 1, updatedAt: null, records: {} };
    return data;
  } catch (_) {
    return { version: 1, updatedAt: null, records: {} };
  }
}

function saveHealthCache(cache) {
  cache.updatedAt = new Date().toISOString();
  writeJsonAtomic(HEALTH_CACHE_PATH(), cache);
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

function buildVisibleTasks(records, cache) {
  const tasks = [];
  for (const record of records) {
    const codeProp = record.properties.Code || record.properties.code;
    const code = codeProp?.rich_text?.[0]?.plain_text?.trim();
    if (!code) continue;

    for (const slotDef of VOLATILE_SLOTS) {
      const currentUrl = record.properties[slotDef.propName]?.url ?? null;
      if (!currentUrl) continue;

      tasks.push({
        recordId: record.id,
        code,
        slot: slotDef.slot,
        propName: slotDef.propName,
        currentUrl,
        expectedUrl: slotDef.buildExpectedUrl(code),
        source: 'visible',
        dedupeKey: `${record.id}:${slotDef.slot}`,
      });
    }
  }
  return tasks;
}

function buildRetryTasks(cache, recordsById, now) {
  const tasks = [];
  for (const [recordId, rec] of Object.entries(cache.records ?? {})) {
    if (!rec.slots) continue;

    for (const [slotName, slotState] of Object.entries(rec.slots)) {
      if (slotState.status === 'permanentlyInvalid') continue;
      if (slotState.nextRetryAt && slotState.nextRetryAt > now) continue;

      const slotDef = VOLATILE_SLOTS.find(s => s.slot === slotName);
      if (!slotDef) continue;

      const record = recordsById[recordId];
      if (!record) continue;

      const codeProp = record.properties.Code || record.properties.code;
      const code = codeProp?.rich_text?.[0]?.plain_text?.trim() || rec.code || '?';
      const currentUrl = record.properties[slotDef.propName]?.url ?? null;

      tasks.push({
        recordId,
        code,
        slot: slotName,
        propName: slotDef.propName,
        currentUrl,
        expectedUrl: slotDef.buildExpectedUrl(code),
        source: 'retry',
        dedupeKey: `${recordId}:${slotName}`,
      });
    }
  }
  return tasks;
}

function buildBootstrapTasks(records, cache) {
  const tasks = [];
  for (const record of records) {
    const codeProp = record.properties.Code || record.properties.code;
    const code = codeProp?.rich_text?.[0]?.plain_text?.trim();
    if (!code) continue;

    for (const slotDef of VOLATILE_SLOTS) {
      const currentUrl = record.properties[slotDef.propName]?.url ?? null;
      if (currentUrl) continue;

      const cacheRec = cache.records?.[record.id];
      const slotState = cacheRec?.slots?.[slotDef.slot];
      if (slotState) continue; // Already tracked — retry will handle

      tasks.push({
        recordId: record.id,
        code,
        slot: slotDef.slot,
        propName: slotDef.propName,
        currentUrl: null,
        expectedUrl: slotDef.buildExpectedUrl(code),
        source: 'bootstrap',
        dedupeKey: `${record.id}:${slotDef.slot}`,
      });
    }
  }
  return tasks;
}

function dedupeTasks(tasks) {
  const sourcePriority = { visible: 3, retry: 2, bootstrap: 1 };
  const map = new Map();
  for (const t of tasks) {
    const existing = map.get(t.dedupeKey);
    if (!existing || sourcePriority[t.source] > sourcePriority[existing.source]) {
      map.set(t.dedupeKey, t);
    }
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Worker queue
// ---------------------------------------------------------------------------
async function runTaskQueue(tasks, concurrency, workerFn) {
  if (tasks.length === 0) return [];
  let index = 0;
  const results = [];

  async function worker() {
    while (true) {
      const i = index++;
      if (i >= tasks.length) return;
      results[i] = await workerFn(tasks[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

// ---------------------------------------------------------------------------
// URL checker
// ---------------------------------------------------------------------------
async function checkUrl(pool, url) {
  // Try up to 2 times with different sessions (handles CF solve timeout on cold start)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const opts = { maxTimeout: FS_TIMEOUT };
      if (attempt > 1) {
        opts.forceFreshSession = true;
        log(`[verify-url] Retry ${url} with fresh session`, 'debug');
      }
      const { html } = await pool.requestGet(url, opts);
      const result = evaluatePage(html);
      if (result !== 'unknown') return result;
      // If unknown on first attempt, retry with fresh session
      if (attempt === 1) {
        log(`[verify-url] Unknown result for ${url}, will retry with fresh session`, 'debug');
        continue;
      }
      return 'unknown';
    } catch (e) {
      if (attempt < 2) {
        log(`[verify-url] Attempt ${attempt} failed for ${url}: ${e.message}`, 'debug');
        continue;
      }
      log(`[verify-url] checkUrl error for ${url}: ${e.message}`, 'warn');
      return 'unknown';
    }
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// State machine — apply result per task type
// ---------------------------------------------------------------------------

function applyVisibleResult(task, result, cache, now) {
  const { recordId, slot, propName, expectedUrl } = task;
  if (!cache.records) cache.records = {};
  const cacheRec = cache.records[recordId] ??= { code: task.code, slots: {} };
  if (!cacheRec.slots) cacheRec.slots = {};
  const slotState = cacheRec.slots[slot] ??= {};

  if (result === true) {
    delete cacheRec.slots[slot];
    return { notionUpdate: null };
  }

  if (result === 'unknown') {
    slotState.status = 'unknown';
    slotState.lastOutcome = 'unknown';
    slotState.lastCheckedAt = now;
    slotState.hiddenInNotion = slotState.hiddenInNotion ?? false;
    slotState.nextRetryAt = nextScheduleSlotMs(now);
    return { notionUpdate: null };
  }

  // Invalid result
  slotState.lastOutcome = 'invalid';
  slotState.lastCheckedAt = now;
  slotState.expectedUrl = expectedUrl;

  if (slotState.status === 'suspect' || slotState.status === 'invalid') {
    // Second consecutive fail → clear Notion
    slotState.status = 'invalid';
    slotState.failCount = (slotState.failCount ?? 1) + 1;
    slotState.nextRetryAt = now + invalidBackoffMs(slotState.failCount);
    slotState.hiddenInNotion = true;
    return { notionUpdate: { propName, value: null } };
  }

  // First fail → mark suspect, keep URL visible
  slotState.status = 'suspect';
  slotState.failCount = 1;
  slotState.nextRetryAt = nextScheduleSlotMs(now);
  slotState.hiddenInNotion = false;
  return { notionUpdate: null };
}

function applyRetryResult(task, result, cache, now) {
  const { recordId, slot, propName, expectedUrl } = task;
  if (!cache.records) cache.records = {};
  const cacheRec = cache.records[recordId] ??= { code: task.code, slots: {} };
  if (!cacheRec.slots) cacheRec.slots = {};
  const slotState = cacheRec.slots[slot] ??= {};
  slotState.expectedUrl = expectedUrl;

  if (result === true) {
    delete cacheRec.slots[slot];
    return { notionUpdate: { propName, value: expectedUrl } };
  }

  if (result === 'unknown') {
    slotState.status = 'unknown';
    slotState.lastOutcome = 'unknown';
    slotState.lastCheckedAt = now;
    slotState.hiddenInNotion = true;
    slotState.nextRetryAt = nextScheduleSlotMs(now);
    return { notionUpdate: null };
  }

  // Invalid again
  slotState.failCount = (slotState.failCount ?? 0) + 1;
  slotState.lastOutcome = 'invalid';
  slotState.lastCheckedAt = now;
  slotState.hiddenInNotion = true;

  if (slotState.failCount >= MAX_RETRIES) {
    slotState.status = 'permanentlyInvalid';
    delete slotState.nextRetryAt;
  } else {
    slotState.status = 'invalid';
    slotState.nextRetryAt = now + invalidBackoffMs(slotState.failCount);
  }

  return { notionUpdate: null };
}

function applyBootstrapResult(task, result, cache, now) {
  const { recordId, slot, propName, expectedUrl } = task;
  if (!cache.records) cache.records = {};
  const cacheRec = cache.records[recordId] ??= { code: task.code, slots: {} };
  if (!cacheRec.slots) cacheRec.slots = {};
  const slotState = cacheRec.slots[slot] ??= {};
  slotState.expectedUrl = expectedUrl;

  if (result === true) {
    delete cacheRec.slots[slot];
    return { notionUpdate: { propName, value: expectedUrl } };
  }

  if (result === 'unknown') {
    slotState.status = 'unknown';
    slotState.lastOutcome = 'unknown';
    slotState.lastCheckedAt = now;
    slotState.hiddenInNotion = true;
    slotState.nextRetryAt = nextScheduleSlotMs(now);
    return { notionUpdate: null };
  }

  // Invalid
  slotState.status = 'invalid';
  slotState.failCount = 1;
  slotState.lastOutcome = 'invalid';
  slotState.lastCheckedAt = now;
  slotState.nextRetryAt = now + invalidBackoffMs(1);
  slotState.hiddenInNotion = true;
  return { notionUpdate: null };
}

// ---------------------------------------------------------------------------
// Notion update aggregator
// ---------------------------------------------------------------------------
function collectPageUpdates(taskResults) {
  const pageUpdates = new Map();

  for (const { task, notionUpdate } of taskResults) {
    if (!notionUpdate) continue;
    if (!pageUpdates.has(task.recordId)) {
      pageUpdates.set(task.recordId, { recordId: task.recordId, properties: {} });
    }
    pageUpdates.get(task.recordId).properties[notionUpdate.propName] = { url: notionUpdate.value };
  }

  return pageUpdates;
}

// ---------------------------------------------------------------------------
// Housekeeping — prune stale cache, keep resolved records with timestamp
// ---------------------------------------------------------------------------
function housekeepCache(cache, activeRecordIds) {
  const activeSet = new Set(activeRecordIds);
  const toDelete = [];

  for (const [pageId, rec] of Object.entries(cache.records ?? {})) {
    if (!activeSet.has(pageId)) {
      toDelete.push(pageId);
      continue;
    }

    // Clean stale suspect entries (>7d without recheck)
    if (rec.slots) {
      const staleCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [slotName, slotState] of Object.entries(rec.slots)) {
        if (slotState.status === 'suspect' && slotState.lastCheckedAt && slotState.lastCheckedAt < staleCutoff) {
          delete rec.slots[slotName];
        }
      }

      // All slots resolved → mark resolvedAt (keep record for audit)
      if (Object.keys(rec.slots).length === 0) {
        rec.resolvedAt = rec.resolvedAt || new Date().toISOString();
      }
    }
  }

  for (const pageId of toDelete) {
    delete cache.records[pageId];
  }

  return cache;
}

// ---------------------------------------------------------------------------
// Simulate fake records for testing
// ---------------------------------------------------------------------------
function generateFakeRecords(n) {
  const records = [];
  for (let i = 0; i < n; i++) {
    const l = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
    const code = `${l()}${l()}${l()}-${100 + Math.floor(Math.random() * 900)}`;
    records.push({
      id: `fake-${i}`,
      properties: {
        Code:          { rich_text: [{ plain_text: code }] },
        URL:           { url: null },
        'URL no code': { url: null },
        'URL Chinese': { url: null },
      },
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const {
    dryRun, verbose, limit, simulateRecords,
    visibleOnly, retryOnly, maxRetryItems, concurrency = DEFAULT_CONCURRENCY,
  } = options;

  const lockPath = getLockPath();
  if (!acquireLock(lockPath)) {
    return { stage: 'verify-url', status: 'skipped', reason: 'lock held' };
  }

  try {
    return await _run({ dryRun, verbose, limit, simulateRecords, visibleOnly, retryOnly, maxRetryItems }, concurrency);
  } finally {
    releaseLock(lockPath);
  }
}

async function _run(options, concurrency) {
  const { dryRun, verbose, limit, simulateRecords, visibleOnly, retryOnly, maxRetryItems } = options;

  const stats = {
    processed: 0,
    updated: 0,
    cleared: 0,
    unknown: 0,
    errors: 0,
    skipped: 0,
    restored: 0,
    noCode_set: 0,
    noCode_invalid: 0,
    chinese_set: 0,
    chinese_invalid: 0,
    permanentlyInvalid: 0,
  };
  const now = Date.now();

  log(`[verify-url] Starting v3 — dryRun=${!!dryRun} verbose=${!!verbose} limit=${limit} simulate=${simulateRecords} visibleOnly=${!!visibleOnly} retryOnly=${!!retryOnly}`, 'info');

  // ── Init FlareSolverr pool ───────────────────────────────────────────
  const fsPool = new FlareSolverrPool({
    ports: FLARESOLVERR_PORTS,
    maxTimeout: FS_TIMEOUT,
    warmupTimeout: FS_WARMUP,
    cooldownMs: FS_COOLDOWN,
    requestDelayMs: FS_DELAY,
    maxFailStreak: FS_FAILSTREAK,
    session: `jav-verify-${Date.now()}`,
    warmupUrl: 'https://missav.ai/',
  });
  await fsPool.initialize();

  // ── Load cache ───────────────────────────────────────────────────────
  const cache = loadHealthCache();

  // ── Fetch records ────────────────────────────────────────────────────
  let records = [];
  const notion = simulateRecords > 0 ? null : new Client({ auth: process.env.NOTION_TOKEN });

  if (simulateRecords > 0) {
    records = generateFakeRecords(simulateRecords);
  } else {
    const dbId = process.env.NOTION_DATABASE_ID;
    if (!dbId) {
      log('[verify-url] NOTION_DATABASE_ID not set', 'error');
      return { stage: 'verify-url', status: 'failed', errors: ['NOTION_DATABASE_ID not configured'] };
    }
    let cursor;
    do {
      const resp = await notionRetry(
        () => notion.databases.query({
          database_id: dbId,
          filter: { property: 'Status', select: { equals: 'Active' } },
          start_cursor: cursor, page_size: 100,
        }),
        'notion.databases.query', 3
      );
      if (!resp) break;
      records.push(...resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
  }

  log(`[verify-url] Fetched ${records.length} Active records`, 'info');

  if (limit > 0 && limit < records.length) {
    records = records.slice(0, limit);
  }

  // ── Index ────────────────────────────────────────────────────────────
  const recordsById = Object.fromEntries(records.map(r => [r.id, r]));
  const activeRecordIds = records.map(r => r.id);

  housekeepCache(cache, activeRecordIds);

  // ── Build tasks (bootstrap always enabled) ───────────────────────────
  let visibleTasks = [];
  let retryTasks = [];
  let bootstrapTasks = [];

  if (visibleOnly) {
    visibleTasks = buildVisibleTasks(records, cache);
  } else if (retryOnly) {
    retryTasks = buildRetryTasks(cache, recordsById, now).slice(0, maxRetryItems);
  } else {
    visibleTasks = buildVisibleTasks(records, cache);
    retryTasks = buildRetryTasks(cache, recordsById, now).slice(0, maxRetryItems);
    bootstrapTasks = buildBootstrapTasks(records, cache);
  }

  let allTasks = dedupeTasks([...visibleTasks, ...retryTasks, ...bootstrapTasks]);

  log(`[verify-url] Tasks: visible=${visibleTasks.length} retry=${retryTasks.length} bootstrap=${bootstrapTasks.length} total=${allTasks.length}`, 'info');

  if (allTasks.length === 0) {
    log('[verify-url] No tasks to run', 'info');
    saveHealthCache(cache);
    return { stage: 'verify-url', status: 'completed', ...stats, dryRun: !!dryRun, tasks: 0 };
  }

  // ── Execute ──────────────────────────────────────────────────────────
  const healthyPorts = fsPool.getHealthyPorts();
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, healthyPorts.length));
  if (effectiveConcurrency !== concurrency) {
    log(`[verify-url] Reduced concurrency ${concurrency} → ${effectiveConcurrency}`, 'info');
  }

  const taskResults = await runTaskQueue(allTasks, effectiveConcurrency, async (task) => {
    const url = task.currentUrl ?? task.expectedUrl;
    const result = await checkUrl(fsPool, url);
    stats.processed++;

    let notionUpdate = null;

    if (task.source === 'visible') {
      ({ notionUpdate } = applyVisibleResult(task, result, cache, now));
    } else if (task.source === 'retry') {
      ({ notionUpdate } = applyRetryResult(task, result, cache, now));
    } else {
      ({ notionUpdate } = applyBootstrapResult(task, result, cache, now));
    }

    // Per-property counters
    if (result === 'unknown') {
      stats.unknown++;
    } else if (result === false) {
      if (task.slot === 'noCode') stats.noCode_invalid++;
      else if (task.slot === 'chinese') stats.chinese_invalid++;
    }

    if (notionUpdate) {
      if (notionUpdate.value === null) {
        stats.cleared++;
      } else {
        stats.updated++;
        if (task.slot === 'noCode') stats.noCode_set++;
        else if (task.slot === 'chinese') stats.chinese_set++;
        if (task.source === 'retry') stats.restored++;
      }
    }

    return { task, result, notionUpdate };
  });

  // ── Apply Notion page updates ────────────────────────────────────────
  if (!dryRun && !simulateRecords) {
    const pageUpdates = collectPageUpdates(taskResults);
    log(`[verify-url] Applying ${pageUpdates.size} Notion page updates`, 'info');

    for (const [recordId, update] of pageUpdates) {
      const code = recordsById[recordId]?.properties?.Code?.rich_text?.[0]?.plain_text ?? recordId;
      await notionRetry(
        () => notion.pages.update({ page_id: recordId, properties: update.properties }),
        `patch-${code}`, 3
      );
      await sleep(NOTION_PATCH_DELAY);
    }
  }

  // ── Count permanentlyInvalid ────────────────────────────────────────
  for (const rec of Object.values(cache.records ?? {})) {
    if (!rec.slots) continue;
    for (const slotState of Object.values(rec.slots)) {
      if (slotState.status === 'permanentlyInvalid') stats.permanentlyInvalid++;
    }
  }

  housekeepCache(cache, activeRecordIds);
  saveHealthCache(cache);

  log(`[verify-url] Done — processed=${stats.processed} updated=${stats.updated} cleared=${stats.cleared} unknown=${stats.unknown} restored=${stats.restored} noCode_set=${stats.noCode_set} noCode_invalid=${stats.noCode_invalid} chinese_set=${stats.chinese_set} chinese_invalid=${stats.chinese_invalid} permanentlyInvalid=${stats.permanentlyInvalid}`, 'info');

  return {
    stage: 'verify-url',
    status: 'completed',
    ...stats,
    dryRun: !!dryRun,
    tasks: allTasks.length,
    cacheEntries: Object.keys(cache.records ?? {}).length,
  };
}

export const config = {
  name: 'verify-url',
  description: 'FlareSolverr-based missav.ai URL verification for Notion records (v3 — bootstrap auto-enabled, permanentlyInvalid guard, per-property stats)',
  dependencies: [],
};
