/**
 * Stage 6: Notify — Smart Telegram Notification
 *
 * Responsibilities:
 * 1. New Videos  — query Notion for recently-created items not yet notified
 *                  (reads cache/ingest/metadata.json + tracks notified-codes.json)
 * 2. Rankings    — Daily / Weekly / Monthly Star diffing vs persisted snapshots
 * 3. Triple Crown — all-3-stars diffing vs persisted snapshot (existing logic, fixed)
 *
 * All history files store objects { code, updatedAt } for reliable diffing.
 */

import { getSkillPath, writeJsonAtomic, readJson, log } from '../lib/shared.mjs';
import { Client } from '@notionhq/client';
import { existsSync, readFileSync } from 'fs';
import { Telegraf } from 'telegraf';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const NOTION_PAGE_SIZE = 100;
const TG_CHUNK_SIZE    = 3800;
const FAILED_PER_SECTION = 25;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Escape text for Telegram HTML parse mode.
 * Only < > & need escaping; ' is fine outside attributes.
 */
function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Build a Telegram HTML hyperlink: <a href="url">text</a>
 */
function htmlLink(text, url) {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

async function notionRetry(fn, label = 'notion') {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const retryable = [429, 502, 503, 504].includes(e.status) ||
        e.code === 'retry' || e.code === 'request_timeout';
      if (!retryable || attempt === 2) throw e;
      const wait = 1000 * 2 ** attempt;
      log(`[notify] [${label}] transient error (attempt ${attempt + 1}/3), retry in ${wait}ms: ${e.message}`, 'warn');
      await sleep(wait);
    }
  }
}

// ---------------------------------------------------------------------------
// Step 1: Persisted snapshot helpers (all ranking types use this format)
// ---------------------------------------------------------------------------

/**
 * Load a ranking snapshot from disk.
 * @param {string} type  - 'triple_crown' | 'daily' | 'weekly' | 'monthly'
 * @returns {{ updatedAt: string, items: Array<{code:string, maker:string, actress:string, title:string}> }}
 */
function loadSnapshot(type) {
  const path = getSkillPath(`cache/${type}_snapshot.json`);
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf8'));
    }
  } catch (_) {}
  return { updatedAt: null, items: [] };
}

/**
 * Persist a ranking snapshot to disk.
 */
function saveSnapshot(type, items) {
  const path = getSkillPath(`cache/${type}_snapshot.json`);
  writeJsonAtomic(path, { updatedAt: new Date().toISOString(), items });
}

/**
 * Load the notified-codes set (ever notified new videos).
 */
function loadNotifiedCodes() {
  const path = getSkillPath('cache/notified_codes.json');
  try {
    if (existsSync(path)) {
      const arr = JSON.parse(readFileSync(path, 'utf8'));
      return new Set(Array.isArray(arr) ? arr : []);
    }
  } catch (_) {}
  return new Set();
}

/**
 * Add newly notified codes to the persisted set.
 */
function saveNotifiedCodes(codes) {
  const path = getSkillPath('cache/notified_codes.json');
  const existing = loadNotifiedCodes();
  codes.forEach(c => existing.add(c));
  writeJsonAtomic(path, Array.from(existing));
}

// ---------------------------------------------------------------------------
// Step 2: Notion query helpers
// ---------------------------------------------------------------------------

/**
 * Extract key fields from a Notion page record.
 * Includes the "URL" property (url type) for use as a clickable link.
 */
function extractRecord(record) {
  const props = record.properties || {};
  return {
    code:     props.Code?.rich_text?.[0]?.plain_text?.trim() || '',
    maker:    props.Maker?.rich_text?.[0]?.plain_text?.trim() || '',
    actress:  props.Actress?.rich_text?.[0]?.plain_text?.trim() || '',
    title:    props.Name?.title?.[0]?.plain_text?.trim() || '',
    url:      props.URL?.url || null,
  };
}

/**
 * Query Notion for pages matching a checkbox filter, paginating through all results.
 */
async function queryByCheckbox(notion, databaseId, propertyName) {
  const records = [];
  let cursor;
  do {
    const resp = await notionRetry(
      () => notion.databases.query({
        database_id: databaseId,
        filter: { property: propertyName, checkbox: { equals: true } },
        start_cursor: cursor,
        page_size: NOTION_PAGE_SIZE,
      }),
      `query-${propertyName}`
    );
    records.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);
  return records.map(extractRecord);
}

/**
 * Query Notion for recently created pages (by Created time), sorted newest first.
 * Used to find genuinely new videos even when earlier pipeline stages didn't run.
 */
async function queryRecentItems(notion, databaseId, limit = 50) {
  const records = [];
  let cursor;
  let fetched = 0;
  do {
    const resp = await notionRetry(
      () => notion.databases.query({
        database_id: databaseId,
        sorts: [{ timestamp: 'created_time', direction: 'descending' }],
        start_cursor: cursor,
        page_size: NOTION_PAGE_SIZE,
      }),
      'query-recent'
    );
    for (const r of resp.results) {
      records.push(extractRecord(r));
      fetched++;
      if (fetched >= limit) break;
    }
    cursor = resp.has_more ? resp.next_cursor : undefined;
    if (fetched >= limit) break;
  } while (cursor);
  return records;
}

// ---------------------------------------------------------------------------
// Step 3: Diffing engines
// ---------------------------------------------------------------------------

/**
 * Diff two ranking snapshots and return human-readable change lines.
 * New entries only — removed entries are intentionally skipped.
 *
 * Format per item (single-line, Telegram HTML):
 *   <a href="URL">CODE</a> | Maker | Actress | Title  🆕label  ❤️
 */
function diffSnapshots(prevItems, currItems, label, favorites = []) {
  const currMap = new Map(currItems.map(i => [i.code, i]));
  const prevCodes = new Set(prevItems.map(i => i.code));

  const lines = [];
  for (const code of currMap.keys()) {
    if (!prevCodes.has(code)) {
      const item = currMap.get(code);
      const url = item.url || `https://javdb.com/v/${item.code}`;
      const link = htmlLink(item.code, url);
      const titlePart = `${escapeHtml(item.title || '')}  🆕${label}`;
      const favoriteMarker = hasFavoriteActress(item.actress, favorites) ? '❤️' : null;
      const parts = [
        link,
        escapeHtml(item.maker || ''),
        escapeHtml(item.actress || ''),
        titlePart,
      ];
      if (favoriteMarker) parts.push(favoriteMarker);
      lines.push(parts.join(' | '));
    }
  }

  return lines;
}

/**
 * Format new video lines from an array of { code, maker, actress, title, url }.
 * Single-line format with Telegram HTML hyperlinks.
 *
 * Format per item (Telegram HTML):
 *   <a href="URL">CODE</a> | Maker | Actress | Title  ❤️
 */
function splitActressNames(actressText) {
  return String(actressText || '')
    .split(/[、,，／/]/)
    .map(name => name.trim())
    .filter(Boolean);
}

function hasFavoriteActress(actressText, favorites) {
  const favSet = new Set(favorites || []);
  return splitActressNames(actressText).some(name => favSet.has(name));
}

function formatNewVideos(newItems, favorites) {
  return newItems.map(v => {
    const url = v.url || `https://javdb.com/v/${v.code}`;
    const link = htmlLink(v.code, url);
    const parts = [
      link,
      escapeHtml(v.maker || ''),
      escapeHtml(v.actress || ''),
      escapeHtml(v.title || ''),
    ];
    if (hasFavoriteActress(v.actress, favorites)) parts.push('❤️');
    return parts.join(' | ');
  });
}

// ---------------------------------------------------------------------------
// Step 4: Telegram sender
// ---------------------------------------------------------------------------

/**
 * Send a long message to Telegram, splitting on newline boundaries near
 * TG_CHUNK_SIZE to keep individual messages readable.
 */
async function sendLongReport(bot, chatId, text) {
  // Split on paragraph (double-newline) boundaries to avoid breaking MarkdownV2 entities
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_CHUNK_SIZE) {
      chunks.push(remaining);
      break;
    }
    // Find the last double-newline (paragraph boundary) within chunk size
    let cut = remaining.lastIndexOf('\n\n', TG_CHUNK_SIZE);
    if (cut === -1 || cut < TG_CHUNK_SIZE / 3) {
      // Fallback to single newline
      cut = remaining.lastIndexOf('\n', TG_CHUNK_SIZE);
    }
    if (cut === -1 || cut < TG_CHUNK_SIZE / 3) {
      // No good break point — hard cut at chunk size
      cut = TG_CHUNK_SIZE;
    }
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^[\n\r]+/, '');
  }

  log(`[notify] sendLongReport: ${text.length} chars → ${chunks.length} chunk(s)`, 'info');

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i].replace(/^[\n\r]+|[\n\r]+$/g, '');
    if (!chunk) continue;
    try {
      await bot.telegram.sendMessage(chatId, chunk, {
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      });
    } catch (err) {
      log(`[notify] Chunk ${i + 1} send failed: ${err.message}`, 'error');
    }
    if (i < chunks.length - 1) await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// Step 5: Per-ranking-type notification engine
// ---------------------------------------------------------------------------

/**
 * Check a single ranking type (e.g. 'daily', 'weekly', 'monthly', 'triple_crown').
 * Loads previous snapshot, queries current Notion state, diffs, formats, saves new snapshot.
 *
 * @returns {Array<string>} Formatted change lines
 */
async function checkRanking(notion, databaseId, type, propertyName, label, favorites = []) {
  const prev = loadSnapshot(type);
  const records = await queryByCheckbox(notion, databaseId, propertyName);
  const currItems = records.filter(r => r.code);

  log(`[notify] [${type}] previous=${prev.items.length} current=${currItems.length}`, 'info');

  const changes = diffSnapshots(prev.items, currItems, label, favorites);

  if (changes.length > 0) {
    log(`[notify] [${type}] ${changes.length} change(s) detected`, 'info');
    saveSnapshot(type, currItems);
  } else {
    log(`[notify] [${type}] no changes`, 'info');
  }

  return changes;
}

// ---------------------------------------------------------------------------
// Step 6: New videos from ingest cache + Notion recent query
// ---------------------------------------------------------------------------

/**
 * Find genuinely new videos by:
 * 1. Reading codes from cache/ingest/metadata.json (Stage 1 output)
 * 2. Reading codes from Notion's recently created pages
 * 3. Diffing against notified_codes.json
 *
 * Items from Notion query include the "URL" property for use as clickable links.
 * Items from ingest cache get a JavDB page URL generated from the code.
 *
 * @returns {Array<{code,maker,actress,title,url}>}
 */
async function findNewVideos(notion, databaseId, favorites) {
  const notifiedCodes = loadNotifiedCodes();
  const ingestCodes = new Set();
  let ingestItems = [];

  // 1. Read Stage 1 ingest cache
  const ingestMetaPath = getSkillPath('cache/ingest/metadata.json');
  try {
    if (existsSync(ingestMetaPath)) {
      const raw = JSON.parse(readFileSync(ingestMetaPath, 'utf8'));
      for (const entry of Array.isArray(raw) ? raw : []) {
        const code = entry.code || entry.metadata?.code;
        if (code) {
          ingestCodes.add(code);
          ingestItems.push({
            code,
            maker:    entry.metadata?.maker    || '',
            actress:  (entry.metadata?.actresses || []).join(', ') || '',
            title:    entry.metadata?.cleanTitle || entry.metadata?.title || '',
            url:      null, // will try to fetch from Notion below
          });
        }
      }
    }
  } catch (_) {}

  // 2. Also query Notion's recently created pages as a fallback
  //    (covers cases where pipeline ran Stage 2 but Stage 1 cache was cleared)
  const recentRecords = await queryRecentItems(notion, databaseId, 100);
  for (const r of recentRecords) {
    if (r.code && !ingestCodes.has(r.code)) {
      ingestCodes.add(r.code);
      ingestItems.push(r); // r includes url from Notion
    }
  }

  // 3. For ingest cache items (may lack URL), try to get URL from Notion pages
  const cacheItemsNoUrl = ingestItems.filter(v => v.url === null);
  if (cacheItemsNoUrl.length > 0) {
    const codeToUrl = new Map();
    for (const r of recentRecords) {
      if (r.code && r.url) codeToUrl.set(r.code, r.url);
    }
    for (const v of cacheItemsNoUrl) {
      const url = codeToUrl.get(v.code);
      if (url) v.url = url;
    }
  }

  log(`[notify] Ingest cache + recent Notion: ${ingestCodes.size} unique codes`, 'info');

  // 4. Filter out already notified
  const newItems = ingestItems.filter(v => !notifiedCodes.has(v.code));
  log(`[notify] New (not yet notified): ${newItems.length} item(s)`, 'info');

  if (newItems.length > 0) {
    saveNotifiedCodes(newItems.map(v => v.code));
  }

  return newItems;
}

// ---------------------------------------------------------------------------
// Step 7: Smart conditional send
// ---------------------------------------------------------------------------

/**
 * Build formatted report and send to Telegram.
 * Sections are separated by blank lines. Each section has:
 *   📌 *HEADING*
 *   ────────────────────────────────────────
 *   item1
 *   item2
 *   ...
 *
 * Returns true if anything was sent, false if all sections empty.
 */
async function smartSend(bot, chatId, sections) {
  const nonEmpty = sections.filter(s => s.lines.length > 0);
  if (nonEmpty.length === 0) {
    log('[notify] Nothing new to report — skipping Telegram send', 'info');
    return false;
  }

  // Build report with proper spacing (actual newlines)
  const divider = '─'.repeat(40);
  const parts = nonEmpty.map(s => {
    const header = `📌 <b>${escapeHtml(s.heading)}</b>`;
    const body = s.lines.join('\n\n');
    return `${header}\n${divider}\n${body}`;
  });

  // Separate sections with blank line
  const finalText = parts.join('\n\n\n');

  log(`[notify] Sending notification: ${finalText.length} chars, ${nonEmpty.length} section(s)`, 'info');

  await sendLongReport(bot, chatId, finalText);
  return true;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const { dryRun = false, verbose = false } = options;

  log(`[notify] Starting — dryRun=${dryRun}`, 'info');

  const notionToken = process.env.NOTION_TOKEN;
  const databaseId  = process.env.NOTION_DATABASE_ID;
  const tgToken     = process.env.TELEGRAM_BOT_TOKEN;
  const tgChatId    = process.env.TELEGRAM_CHAT_ID;

  if (!notionToken || !databaseId) {
    const msg = 'Notion credentials not configured';
    log(`[notify] ${msg}`, 'error');
    return { stage: '06-notify', status: 'error', error: msg };
  }
  if (!tgToken || !tgChatId) {
    const msg = 'Telegram credentials not configured';
    log(`[notify] ${msg}`, 'error');
    return { stage: '06-notify', status: 'error', error: msg };
  }

  const notion    = new Client({ auth: notionToken });
  const bot       = new Telegraf(tgToken);
  const config    = readJson(getSkillPath('config.json'));
  const favorites = config.favorites || [];

  try {
    // ── New videos (from ingest cache + Notion recent) ─────────────────
    const newVideoItems = await findNewVideos(notion, databaseId, favorites);
    const formattedNewVideos = formatNewVideos(newVideoItems, favorites);

    // ── Rankings (Daily / Weekly / Monthly / Triple Crown) ────────────
    const [dailyChanges, weeklyChanges, monthlyChanges] = await Promise.all([
      checkRanking(notion, databaseId, 'daily',    'Daily Star',   '日冠', favorites),
      checkRanking(notion, databaseId, 'weekly',   'Weekly Star',  '週冠', favorites),
      checkRanking(notion, databaseId, 'monthly',  'Monthly Star', '月冠', favorites),
    ]);

    // Triple Crown: re-use ranking snapshots (Daily ∩ Weekly ∩ Monthly)
    const dailyItems   = loadSnapshot('daily').items;
    const weeklyItems  = loadSnapshot('weekly').items;
    const monthlyItems = loadSnapshot('monthly').items;

    const weeklyCodes  = new Set(weeklyItems.map(i => i.code));
    const monthlyCodes = new Set(monthlyItems.map(i => i.code));
    const tripleCurr   = dailyItems.filter(i => weeklyCodes.has(i.code) && monthlyCodes.has(i.code));

    const prevTriple = loadSnapshot('triple_crown');
    const tripleLines = diffSnapshots(prevTriple.items, tripleCurr, '三冠王', favorites);
    if (tripleLines.length > 0) {
      log(`[notify] [triple_crown] ${tripleLines.length} change(s) detected`, 'info');
      saveSnapshot('triple_crown', tripleCurr);
    } else {
      log('[notify] [triple_crown] no changes', 'info');
    }

    // ── Build sections ─────────────────────────────────────────────────
    const sections = [];

    if (formattedNewVideos.length > 0) {
      sections.push({ heading: '🆕 新片同步報告', lines: formattedNewVideos });
    }

    if (dailyChanges.length > 0) {
      sections.push({ heading: '🏆 每日之星排名變動', lines: dailyChanges });
    }
    if (weeklyChanges.length > 0) {
      sections.push({ heading: '🌟 每周之星排名變動', lines: weeklyChanges });
    }
    if (monthlyChanges.length > 0) {
      sections.push({ heading: '🌙 每月之星排名變動', lines: monthlyChanges });
    }
    if (tripleLines.length > 0) {
      sections.push({ heading: '👑 全新三冠王熱門神作', lines: tripleLines });
    }

    // ── Permanently failed items (from Stage 1 post-retry) ────────────
    const permFailedPath = getSkillPath('cache/ingest/permanently-failed.json');
    if (existsSync(permFailedPath)) {
      try {
        const permFailed = JSON.parse(readFileSync(permFailedPath, 'utf8'));
        if (Array.isArray(permFailed) && permFailed.length > 0) {
          // Split into sub-sections so each message chunk stays manageable
          for (let offset = 0; offset < permFailed.length; offset += FAILED_PER_SECTION) {
            const batch = permFailed.slice(offset, offset + FAILED_PER_SECTION);
            const start = offset + 1;
            const end = Math.min(offset + FAILED_PER_SECTION, permFailed.length);
            const failedLines = batch.map(item => {
              const url = item.url || `https://javdb.com/v/${item.code}`;
              return htmlLink(item.code, url);
            });
            sections.push({
              heading: `⚠️ 無法擷取項目 (${start}–${end} / ${permFailed.length})`,
              lines: failedLines,
            });
          }
          log(`[notify] Reporting ${permFailed.length} permanently failed item(s) in ${Math.ceil(permFailed.length / FAILED_PER_SECTION)} section(s)`, 'info');
        }
      } catch (_) {
        log('[notify] Failed to parse permanently-failed.json', 'warn');
      }
    }

    if (dryRun) {
      log('[notify] DRY RUN — would have sent:', 'warn');
      for (const s of sections) {
        if (s.lines.length > 0) log(`[notify] [DRY] ${s.heading}:\n${s.lines.join('\n')}`, 'info');
      }
      if (sections.every(s => s.lines.length === 0)) log('[notify] [DRY] Nothing to report', 'info');
    } else {
      await smartSend(bot, tgChatId, sections);
    }

    const summary = {
      stage:             '06-notify',
      status:            'completed',
      newVideos:         formattedNewVideos.length,
      dailyChanges:      dailyChanges.length,
      weeklyChanges:     weeklyChanges.length,
      monthlyChanges:    monthlyChanges.length,
      tripleCrowns:      tripleLines.length,
      sent:              !dryRun && sections.some(s => s.lines.length > 0),
      dryRun:            !!dryRun,
      runAt:             new Date().toISOString(),
    };

    writeJsonAtomic(getSkillPath('cache/notify-summary.json'), summary);
    log(`[notify] Done — ${JSON.stringify(summary)}`, 'info');
    return summary;

  } finally {
    // Telegraf bot never launched — stop() is a no-op but kept for safety
    if (!dryRun) {
      try { bot.stop(); } catch (_) {}
    }
  }
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
export { diffSnapshots };
