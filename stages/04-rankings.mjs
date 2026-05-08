/**
 * Stage 04: Rankings — Scrape MissAV hot charts via FlareSolverr and sync to Notion
 *
 * Safer design (v2):
 *   1. getHotCodes()  — scrape 3 ranking endpoints (5 pages each) with per-page health checks
 *   2. syncRankings() — query Notion Active records, diff checkboxes, patch
 *                      with allowUncheck gate to prevent blind unchecks on partial scrapes
 *
 * Safety policy:
 *   - Fully healthy category → allow both check-on and check-off
 *   - Partial / suspicious category → allow check-on only (block uncheck)
 *   - Empty / broken category → skip entirely
 *   - dry-run does full diff but never writes to Notion
 */

import { log, getSkillPath, writeJsonAtomic, sleep, notionRetry } from '../lib/shared.mjs';
import { Client } from '@notionhq/client';
import { load as cheerioLoad } from 'cheerio';
import { FlareSolverrPool } from '../lib/net/flaresolverr-pool.mjs';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RANKING_ENDPOINTS = [
  { key: 'Daily Star',   url: 'https://missav.ai/dm291/today-hot' },
  { key: 'Weekly Star',  url: 'https://missav.ai/dm169/weekly-hot' },
  { key: 'Monthly Star', url: 'https://missav.ai/dm263/monthly-hot' },
];

const PAGES_PER_ENDPOINT    = 5;
const MISSAV_PAGE_DELAY     = 2_000;
const NOTION_PATCH_DELAY    = 300;
const NOTION_PAGE_SIZE      = 100;
const FLARESOLVERR_TIMEOUT  = 60_000;

// Per-page suspicious threshold: fewer items than this is flagged
const MIN_CODES_PER_PAGE    = 10;

const TEST_ARTIFACTS_DIR = 'cache/test-artifacts';



/**
 * Persist a test artifact JSON file.
 * Writes a timestamped copy AND a latest-stable copy.
 * Non-breaking: logs a warning if write fails but does not crash.
 */
function writeTestArtifact(filename, data) {
  const dir = getSkillPath(TEST_ARTIFACTS_DIR);
  const filePath = `${dir}/${filename}`;
  try {
    writeJsonAtomic(filePath, data);
  } catch (err) {
    log(`[rankings] WARN: failed to write artifact ${filename}: ${err.message}`, 'warn');
    return; // don't attempt timestamped if base write failed
  }

  // Also write a timestamped copy for retention across runs
  try {
    const ts = new Date().toISOString().replace(/[.:]/g, '-');
    const tsFileName = `${ts}-${filename}`;
    writeJsonAtomic(`${dir}/${tsFileName}`, data);
  } catch (err) {
    log(`[rankings] WARN: failed to write timestamped artifact: ${err.message}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a raw code string to canonical uppercase form.
 */
function normalizeCode(value) {
  return String(value || '').trim().toUpperCase();
}

/**
 * Read a Notion rich_text property as a single normalized string.
 */
function readRichTextCode(property) {
  return normalizeCode((property?.rich_text || []).map(part => part?.plain_text || '').join(''));
}

/**
 * Extract a slug from an href path segment for sanity-checking against alt.
 * e.g. "https://missav.ai/dm291/fthtd-214" → "FTHTD-214"
 *      "https://missav.ai/fthtd-214"        → "FTHTD-214"
 */
function extractHrefSlug(href) {
  if (!href) return '';
  try {
    // Handle relative and absolute URLs
    const pathname = href.startsWith('http')
      ? new URL(href).pathname
      : href;
    const segments = pathname.split('/').filter(Boolean);
    // The last segment should be the code (may be preceded by a dm### segment)
    const slug = segments[segments.length - 1] || '';
    // Strip query/hash just in case
    return normalizeCode(slug.split(/[?#]/)[0]);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// FlareSolverr pool (shared class, same as Stage 01/03)
// ---------------------------------------------------------------------------
function createFlaresolverrPool() {
  const rawPorts = process.env.JAV_FLARESOLVERR_PORTS || '8191,8192,8193';
  const ports = rawPorts.split(',').map(p => parseInt(p.trim(), 10)).filter(Number.isInteger);
  return new FlareSolverrPool({
    ports: ports.length > 0 ? ports : [8191, 8192, 8193],
    maxTimeout: FLARESOLVERR_TIMEOUT,
    warmupTimeout: 120000,
    cooldownMs: 5 * 60 * 1000,
    requestDelayMs: 500,
    maxFailStreak: 2,
    session: `jav-rankings-${Date.now()}`,
    warmupUrl: 'https://missav.ai/',
  });
}

// ---------------------------------------------------------------------------
// Step 1a: Parse a single ranking page HTML into structured result
// ---------------------------------------------------------------------------

/**
 * @param {string} html - Raw HTML from FlareSolverr
 * @param {object} context - { category, url, page }
 * @returns {object} Page result with codes and health indicators
 */
function extractHotCodesFromHtml(html, context) {
  const $ = cheerioLoad(html);

  const result = {
    codes: new Set(),
    itemCount: 0,
    anchorCount: 0,
    pageTitle: null,
    hasThumbnailGrid: false,
    hasPagination: false,
    suspicious: false,
    reasons: [],
  };

  // Check page title
  const h1Text = $('h1').first().text().trim();
  result.pageTitle = h1Text || null;

  // Check for thumbnail grid and pagination
  result.hasThumbnailGrid = $('div.thumbnail').length > 0;
  result.hasPagination = $('nav span[aria-current="page"], nav a[aria-label]').length > 0 ||
    $('nav input[name="page"]').length > 0;

  // Per-thumbnail extraction: take only the first valid a[alt][href] from each .thumbnail block
  $('div.thumbnail').each((_, el) => {
    const anchor = $(el).find('a[alt][href]').first();
    const rawAlt = anchor.attr('alt');
    const href = anchor.attr('href');
    const code = normalizeCode(rawAlt);

    if (!code) return;
    result.anchorCount++;
    result.codes.add(code);

    // Optional href/alt sanity check
    if (href) {
      const slug = extractHrefSlug(href);
      if (slug && slug !== code) {
        result.reasons.push(`alt/href mismatch: alt=${code} href=${slug}`);
      }
    }
  });

  result.itemCount = result.codes.size;

  // Suspicious detection
  if (!result.pageTitle) {
    result.suspicious = true;
    result.reasons.push('no h1 title');
  }
  if (!result.hasThumbnailGrid) {
    result.suspicious = true;
    result.reasons.push('no .thumbnail grid found');
  }
  if (result.itemCount === 0) {
    result.suspicious = true;
    result.reasons.push('zero codes extracted');
  } else if (result.itemCount < MIN_CODES_PER_PAGE) {
    // Low count could be a nearly-empty page or a sign of scrape trouble
    result.suspicious = true;
    result.reasons.push(`low code count: ${result.itemCount} < ${MIN_CODES_PER_PAGE}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 1b: Fetch a single ranking page
// ---------------------------------------------------------------------------

/**
 * @param {string} category - e.g. 'Daily Star'
 * @param {number} page - Page number (1-based)
 * @param {string} url - Full URL for this page
 * @returns {object} { ok, category, page, url, codes, suspicious, reasons, itemCount }
 */
async function fetchRankingPage(pool, category, page, url) {
  // Test hook: RANKINGS_TEST_FORCE_FAIL_PAGE="Monthly Star:3" forces that page to fail
  const forceFail = process.env.RANKINGS_TEST_FORCE_FAIL_PAGE;
  if (forceFail) {
    const [failCat, failPg] = forceFail.split(':').map(s => s.trim());
    if (failCat === category && parseInt(failPg) === page) {
      log(`[rankings] TEST HOOK: forcing ${category} page ${page} to fail`, 'warn');
      return {
        ok: false,
        category,
        page,
        url,
        codes: new Set(),
        suspicious: true,
        reasons: ['test-hook: forced failure'],
        itemCount: 0,
        pageTitle: null,
      };
    }
  }

  try {
    const { html } = await pool.requestGet(url);
    const parsed = extractHotCodesFromHtml(html, { category, url, page });

    return {
      ok: true,
      category,
      page,
      url,
      codes: parsed.codes,
      suspicious: parsed.suspicious,
      reasons: parsed.reasons,
      itemCount: parsed.itemCount,
      pageTitle: parsed.pageTitle,
    };
  } catch (err) {
    return {
      ok: false,
      category,
      page,
      url,
      codes: new Set(),
      suspicious: true,
      reasons: [`fetch error: ${err.message}`],
      itemCount: 0,
      pageTitle: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 1c: Scrape all pages for one category
// ---------------------------------------------------------------------------

/**
 * @param {FlareSolverrPool} pool
 * @param {string} category
 * @param {string} baseUrl
 * @returns {object} Category scrape report
 */
async function scrapeCategory(pool, category, baseUrl) {
  const pageResults = [];
  const allCodes = new Set();
  let pagesSucceeded = 0;
  let pagesFailed = 0;
  let pagesSuspicious = 0;

  for (let pg = 1; pg <= PAGES_PER_ENDPOINT; pg++) {
    const pageUrl = pg === 1 ? baseUrl : `${baseUrl}?page=${pg}`;
    const pr = await fetchRankingPage(pool, category, pg, pageUrl);

    pageResults.push(pr);

    if (pr.ok && !pr.suspicious) {
      pagesSucceeded++;
    } else if (pr.ok && pr.suspicious) {
      pagesSucceeded++;
      pagesSuspicious++;
    } else {
      pagesFailed++;
    }

    // Merge codes regardless (we still use them for check-on)
    for (const c of pr.codes) allCodes.add(c);

    const tag = pr.ok ? (pr.suspicious ? 'suspicious' : 'ok') : 'FAILED';
    log(`[${category}] page ${pg}: ${tag}, codes=${pr.itemCount}${pr.reasons.length ? ', reasons: ' + pr.reasons.join('; ') : ''}`, 'info');

    if (pg < PAGES_PER_ENDPOINT) await sleep(MISSAV_PAGE_DELAY);
  }

  // Determine health and allowUncheck
  const healthy = pagesSucceeded >= 4 && allCodes.size >= 20;
  const allowUncheck = pagesSucceeded === PAGES_PER_ENDPOINT && pagesSuspicious === 0 && pagesFailed === 0;

  const reasons = [];
  if (pagesFailed > 0) reasons.push(`${pagesFailed} page(s) failed`);
  if (pagesSuspicious > 0) reasons.push(`${pagesSuspicious} page(s) suspicious`);
  if (allCodes.size < 20) reasons.push(`only ${allCodes.size} codes total`);

  const skippedCategory = allCodes.size === 0 && pagesSucceeded < 3;

  log(`[${category}] done: ${allCodes.size} unique codes, allowUncheck=${allowUncheck}, healthy=${healthy}, skipped=${skippedCategory}`, 'info');

  return {
    category,
    codes: allCodes,
    pagesAttempted: PAGES_PER_ENDPOINT,
    pagesSucceeded,
    pagesFailed,
    pagesSuspicious,
    allowUncheck,
    healthy,
    skippedCategory,
    reasons,
    pageResults: pageResults.map(pr => ({
      page: pr.page,
      ok: pr.ok,
      suspicious: pr.suspicious,
      itemCount: pr.itemCount,
      reasons: pr.reasons,
    })),
  };
}

// ---------------------------------------------------------------------------
// Step 1d: Scrape all ranking categories
// ---------------------------------------------------------------------------

/**
 * @param {FlareSolverrPool} pool
 * @returns {object} Map of category key → category scrape report
 */
export async function getHotCodes(pool) {
  const reports = {};

  for (const { key, url } of RANKING_ENDPOINTS) {
    log(`[rankings] Scraping ${key}...`, 'info');
    reports[key] = await scrapeCategory(pool, key, url);
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Step 2: Sync with Notion
// ---------------------------------------------------------------------------

/**
 * @param {object} notion - Notion Client
 * @param {string} databaseId
 * @param {object} rankingReports - Map of category key → scrape report
 * @param {boolean} dryRun
 * @returns {object} Sync stats
 */
export async function syncRankings(notion, databaseId, rankingReports, dryRun = false) {
  const stats = {
    fetched: 0,
    patched: 0,
    checkedOn: 0,
    checkedOff: 0,
    plannedPatched: 0,
    plannedCheckedOn: 0,
    plannedCheckedOff: 0,
    blockedUncheckCount: 0,
    blockedUncheckByCategory: {},
    skipped: 0,
    errors: 0,
    sampleChanges: [],
    allChanges: [],  // Full change list for reconciliation (not capped)
  };
  const categories = ['Daily Star', 'Weekly Star', 'Monthly Star'];

  // Track skipped categories
  for (const cat of categories) {
    const report = rankingReports[cat];
    if (report?.skippedCategory) {
      log(`[rankings] Skipping ${cat}: scrape unusable (${report.reasons.join('; ')})`, 'warn');
    }
  }

  // Fetch all Active records
  const records = [];
  let cursor;
  do {
    const resp = await notionRetry(
      () => notion.databases.query({
        database_id: databaseId,
        filter: { property: 'Status', select: { equals: 'Active' } },
        start_cursor: cursor,
        page_size: NOTION_PAGE_SIZE,
      }),
      'fetch-active', 3
    );
    records.push(...resp.results);
    cursor = resp.has_more ? resp.next_cursor : undefined;
  } while (cursor);

  stats.fetched = records.length;
  log(`[rankings] Fetched ${stats.fetched} Active records`, 'info');

  // Diff & patch
  for (const record of records) {
    try {
      const code = readRichTextCode(record.properties?.Code);
      if (!code) continue;

      const updates = {};
      const blockedUpdates = {};

      for (const cat of categories) {
        const report = rankingReports[cat];
        if (!report || report.skippedCategory) continue;

        const isHotNow = report.codes.has(code);
        const currentBox = record.properties?.[cat]?.checkbox ?? false;

        if (isHotNow && !currentBox) {
          // Always allow check-on
          updates[cat] = { checkbox: true };
        } else if (!isHotNow && currentBox) {
          if (report.allowUncheck) {
            updates[cat] = { checkbox: false };
          } else {
            // Block uncheck — scrape not trustworthy enough
            blockedUpdates[cat] = { checkbox: false };
          }
        }
      }

      // Count blocked unchecks
      for (const [cat] of Object.entries(blockedUpdates)) {
        stats.blockedUncheckCount++;
        stats.blockedUncheckByCategory[cat] = (stats.blockedUncheckByCategory[cat] || 0) + 1;
      }

      // Build change record with oldValue/newValue for reconciliation (even if only blocked unchecks)
      const hasUpdates = Object.keys(updates).length > 0;
      const hasBlocked = Object.keys(blockedUpdates).length > 0;

      if (!hasUpdates && !hasBlocked) { stats.skipped++; continue; }

      if (hasUpdates) {
        const changes = Object.entries(updates).map(([k, v]) => `${k}: ${v.checkbox ? '✓' : '✗'}`).join(', ');
        const blocked = hasBlocked
          ? ` | blocked uncheck: ${Object.keys(blockedUpdates).join(', ')}`
          : '';
        log(`[rankings] ${code}: ${changes}${blocked}${dryRun ? ' (dry)' : ''}`, 'info');
      } else if (hasBlocked) {
        log(`[rankings] ${code}: blocked uncheck only: ${Object.keys(blockedUpdates).join(', ')}${dryRun ? ' (dry)' : ''}`, 'info');
      }

      const changeRecord = {
        pageId: record.id,
        code,
        mode: dryRun ? 'planned' : 'patched',
        updates: {},
        blockedUnchecks: Object.keys(blockedUpdates).map(cat => ({
          category: cat,
          oldValue: record.properties?.[cat]?.checkbox ?? false,
          newValue: false,  // what would have been set
        })),
      };
      for (const [cat, v] of Object.entries(updates)) {
        changeRecord.updates[cat] = {
          oldValue: record.properties?.[cat]?.checkbox ?? false,
          newValue: v.checkbox,
        };
      }

      if (stats.sampleChanges.length < 20) {
        stats.sampleChanges.push(changeRecord);
      }
      stats.allChanges.push(changeRecord);

      if (!hasUpdates) { stats.skipped++; continue; }

      if (dryRun) {
        stats.plannedPatched++;
        for (const v of Object.values(updates)) v.checkbox ? stats.plannedCheckedOn++ : stats.plannedCheckedOff++;
        continue;
      }

      await notionRetry(
        () => notion.pages.update({ page_id: record.id, properties: updates }),
        `patch-${code}`, 3
      );
      stats.patched++;
      for (const v of Object.values(updates)) v.checkbox ? stats.checkedOn++ : stats.checkedOff++;
      await sleep(NOTION_PATCH_DELAY);
    } catch (err) {
      log(`[rankings] Failed for ${record.id}: ${err.message}`, 'error');
      stats.errors++;
    }
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Notion snapshot helper (read-only, for before/after verification)
// ---------------------------------------------------------------------------

/**
 * Fetch current checkbox states for specified page IDs.
 * Returns array of { pageId, code, checkboxes: { 'Daily Star': bool, ... } }
 */
export async function fetchNotionSnapshot(notion, _databaseId_unused, pageIds) {
  const results = [];
  for (const pageId of pageIds) {
    try {
      const page = await notionRetry(
        () => notion.pages.retrieve({ page_id: pageId }),
        `snapshot-${pageId}`, 3
      );
      const code = readRichTextCode(page.properties?.Code);
      const checkboxes = {};
      for (const cat of ['Daily Star', 'Weekly Star', 'Monthly Star']) {
        checkboxes[cat] = page.properties?.[cat]?.checkbox ?? false;
      }
      results.push({ pageId, code, checkboxes });
    } catch (err) {
      log(`[rankings] WARN: failed to snapshot Notion page ${pageId}: ${err.message}`, 'warn');
    }
  }
  return results;
}

/**
 * Persist a Notion snapshot to test artifacts with both stable + timestamped copies.
 */
export function saveNotionSnapshot(filename, snapshotData) {
  writeTestArtifact(filename, {
    capturedAt: new Date().toISOString(),
    records: snapshotData,
  });
}

/**
 * Normalize reconciliation checks so artifact evidence stays self-consistent.
 *
 * Supported patterns:
 * - expectedChange=true  => oldValue should differ from newValue
 * - expectedChange=false => oldValue should equal newValue
 * - optional expectedNewValue / expectedOldValue override the generic rule
 */
export function normalizeReconciliation(reconciliationData = {}) {
  const checks = (reconciliationData.checks || []).map((check) => {
    const oldValue = check.oldValue;
    const newValue = check.newValue;

    let match;
    if (Object.prototype.hasOwnProperty.call(check, 'expectedOldValue') ||
        Object.prototype.hasOwnProperty.call(check, 'expectedNewValue')) {
      match = true;
      if (Object.prototype.hasOwnProperty.call(check, 'expectedOldValue')) {
        match = match && oldValue === check.expectedOldValue;
      }
      if (Object.prototype.hasOwnProperty.call(check, 'expectedNewValue')) {
        match = match && newValue === check.expectedNewValue;
      }
    } else if (Object.prototype.hasOwnProperty.call(check, 'expectedChange')) {
      match = check.expectedChange ? oldValue !== newValue : oldValue === newValue;
    } else if (Object.prototype.hasOwnProperty.call(check, 'match')) {
      match = !!check.match;
    } else {
      match = oldValue === newValue;
    }

    return {
      ...check,
      match,
    };
  });

  return {
    ...reconciliationData,
    checks,
    allMatch: checks.every(check => check.match),
  };
}

/**
 * Persist a reconciliation result to test artifacts with both stable + timestamped copies.
 */
export function saveReconciliation(reconciliationData) {
  writeTestArtifact('reconciliation.json', normalizeReconciliation(reconciliationData));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const { dryRun = false, verbose = false } = options;
  log(`[rankings] Starting — dryRun=${dryRun}`, 'info');

  // Init FlareSolverr pool
  const fsPool = createFlaresolverrPool();
  await fsPool.initialize();

  let rankingReports;
  try {
    rankingReports = await getHotCodes(fsPool);
  } catch (err) {
    log(`[rankings] getHotCodes failed: ${err.message}`, 'error');
    return { stage: '04-rankings', status: 'error', error: err.message };
  }

  // Build scraped summary
  const scraped = {};
  const categoryHealth = {};
  for (const [key, report] of Object.entries(rankingReports)) {
    scraped[key] = report.codes.size;
    categoryHealth[key] = {
      scrapedCodes: report.codes.size,
      pagesAttempted: report.pagesAttempted,
      pagesSucceeded: report.pagesSucceeded,
      pagesFailed: report.pagesFailed,
      pagesSuspicious: report.pagesSuspicious,
      allowUncheck: report.allowUncheck,
      healthy: report.healthy,
      skippedCategory: report.skippedCategory || false,
      reasons: report.reasons,
    };
  }
  log(`[rankings] Scraped: ${JSON.stringify(scraped)}`, 'info');

  // Always require Notion credentials (even for dry-run, which does full diff)
  const notion = new Client({ auth: process.env.NOTION_TOKEN });
  const databaseId = process.env.NOTION_DATABASE_ID;
  if (!databaseId) {
    return { stage: '04-rankings', status: 'error', error: 'NOTION_DATABASE_ID not configured' };
  }

  let syncStats;
  try {
    syncStats = await syncRankings(notion, databaseId, rankingReports, dryRun);
  } catch (err) {
    return { stage: '04-rankings', status: 'error', error: err.message, scraped };
  }

  const summary = {
    stage: '04-rankings',
    status: 'completed',
    dryRun,
    runAt: new Date().toISOString(),
    scraped,
    categories: categoryHealth,
    sync: {
      fetched: syncStats.fetched,
      patched: syncStats.patched,
      checkedOn: syncStats.checkedOn,
      checkedOff: syncStats.checkedOff,
      plannedPatched: syncStats.plannedPatched,
      plannedCheckedOn: syncStats.plannedCheckedOn,
      plannedCheckedOff: syncStats.plannedCheckedOff,
      blockedUncheckCount: syncStats.blockedUncheckCount,
      blockedUncheckByCategory: syncStats.blockedUncheckByCategory,
      skipped: syncStats.skipped,
      errors: syncStats.errors,
    },
    sampleChanges: syncStats.sampleChanges,
  };

  writeJsonAtomic(getSkillPath('cache/rankings-summary.json'), summary);

  // Persist test artifacts for audit trail
  const artifactName = dryRun ? 'dry-run-summary.json' : 'live-run-summary.json';
  writeTestArtifact(artifactName, summary);
  writeTestArtifact('full-changes.json', {
    runAt: summary.runAt,
    dryRun,
    totalChanges: syncStats.allChanges.length,
    changes: syncStats.allChanges,
  });

  // When safety-gate test hook is active, auto-persist dedicated safety-gate artifacts
  const isSafetyGateRun = !!process.env.RANKINGS_TEST_FORCE_FAIL_PAGE;
  if (isSafetyGateRun) {
    writeTestArtifact('safety-gate-summary.json', summary);
    writeTestArtifact('safety-gate-full-changes.json', {
      runAt: summary.runAt,
      dryRun,
      forcedFailPage: process.env.RANKINGS_TEST_FORCE_FAIL_PAGE,
      totalChanges: syncStats.allChanges.length,
      blockedUncheckCount: syncStats.blockedUncheckCount,
      blockedUncheckByCategory: syncStats.blockedUncheckByCategory,
      changes: syncStats.allChanges,
    });
  }
  const outcomeLabel = dryRun
    ? `planned=${syncStats.plannedPatched} (on=${syncStats.plannedCheckedOn} off=${syncStats.plannedCheckedOff})`
    : `patched=${syncStats.patched} (on=${syncStats.checkedOn} off=${syncStats.checkedOff})`;
  log(
    `[rankings] Done — fetched=${syncStats.fetched} ${outcomeLabel} blocked=${syncStats.blockedUncheckCount} errors=${syncStats.errors}`,
    'info'
  );

  return summary;
}

export const config = {
  name: '04-rankings',
  description: 'Scrape MissAV hot charts via FlareSolverr and sync ranking checkboxes to Notion',
  dependencies: [],
};
