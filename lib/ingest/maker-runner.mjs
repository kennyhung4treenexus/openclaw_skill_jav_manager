/**
 * Maker runner — process a single maker: list pages, stop on known code,
 * apply filters, scrape details, write item cache.
 *
 * v2: Per-maker session rotation + large-maker auto-split.
 *     Rotates session every N items (default 40) to keep bot score below CF threshold.
 *     Each worker calls this for one maker at a time.
 */

import { log } from '../shared.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// After this many items, auto-rotate session mid-maker
const ROTATE_AFTER_ITEMS = parseInt(process.env.JAV_INGEST_ROTATE_ITEMS || '40', 10);

/**
 * Run ingest for a single maker.
 *
 * @param {object} params
 * @param {object} params.maker - { name, url }
 * @param {object} params.scraper - JavDBScraper instance
 * @param {Set<string>} params.knownCodes - codes already in Notion
 * @param {object} params.runState - shared run state (seenCodes, extracted, etc.)
 * @param {object} params.itemStore - item-store module
 * @param {object} params.options - { maxPagesPerMaker, filters, dryRun, verbose, downloadCovers }
 * @returns {Promise<object>} summary for this maker
 */
export async function runMakerIngest({
  maker,
  scraper,
  knownCodes,
  runState,
  itemStore,
  options = {},
}) {
  const {
    maxPagesPerMaker = 5,
    filters = {},
    dryRun = false,
    verbose = false,
    downloadCovers = true,
    itemDelayMinMs = 300,
    itemDelayMaxMs = 1000,
    pageDelayMinMs = 2000,
    pageDelayMaxMs = 4000,
    workerId = null,
    onSessionRotate = null,    // async (workerId) → { port, session }
  } = options;

  const summary = {
    maker: maker.name,
    pagesScanned: 0,
    itemsListed: 0,
    itemsQueued: 0,
    itemsExtracted: 0,
    duplicatesSkipped: 0,
    errors: 0,
    stoppedOnKnown: false,
    failedItems: [],   // codes that exhausted all scrapeItem retries
  };

  let pendingCodes = [];
  let shouldContinuePagination = true;

  // ── Page scan ──────────────────────────────────────────
  for (let page = 1; page <= maxPagesPerMaker && shouldContinuePagination; page++) {
    if (runState.stopRequested) break;

    const items = await scraper.listMakerItems(maker.url, page);

    if (!items || items.length === 0) {
      log(
        `[ingest][${maker.name}] Page ${page} yielded no items — stopping pagination`,
        'warn'
      );
      break;
    }

    summary.itemsListed += items.length;
    summary.pagesScanned = page;

    // Separate into known and new
    const knownOnPage = [];
    const newOnPage = [];

    for (const item of items) {
      if (knownCodes.has(item.code)) {
        knownOnPage.push(item);
      } else if (runState.seenCodes.has(item.code)) {
        // Already discovered this run by another worker
        summary.duplicatesSkipped++;
        runState.duplicatesSkipped++;
      } else {
        newOnPage.push(item);
        // Mark immediately to prevent duplicate work
        runState.seenCodes.add(item.code);
      }
    }

    // Apply filters to new items
    const filteredNew = newOnPage.filter((item) => {
      if (item.code.includes('VR')) return false;
      if (filters[maker.name]) {
        return filters[maker.name].some((prefix) => item.code.startsWith(prefix));
      }
      return true;
    });

    if (knownOnPage.length > 0) {
      log(
        `[ingest][${maker.name}] Page ${page}: found ${knownOnPage.length} known code(s), stopping pagination`,
        'info'
      );
      pendingCodes.push(...filteredNew);
      shouldContinuePagination = false;
      summary.stoppedOnKnown = true;
    } else {
      pendingCodes.push(...filteredNew);
      if (verbose) {
        log(
          `[ingest][${maker.name}] Page ${page}: all ${items.length} items new, continuing`,
          'debug'
        );
      }
    }

    // Delay between pages
    const pageDelay =
      Math.floor(Math.random() * (pageDelayMaxMs - pageDelayMinMs)) + pageDelayMinMs;
    await sleep(pageDelay);
  }

  summary.itemsQueued = pendingCodes.length;

  // ── Detail scrape ──────────────────────────────────────
  for (const item of pendingCodes) {
    if (runState.stopRequested) break;

    try {
      log(`[ingest][${maker.name}] Scraping: ${item.code}`, 'info');

      const metadata = await scraper.scrapeItem(item);

      if (metadata) {
        summary.itemsExtracted++;
        runState.extracted++;

        if (!dryRun) {
          // Download cover
          if (downloadCovers) {
            try {
              await scraper.downloadCover(metadata);
            } catch (coverErr) {
              log(
                `[ingest][${maker.name}] Cover download failed for ${item.code}: ${coverErr.message}`,
                'warn'
              );
            }
          }

          // Write per-item cache
          await itemStore.writeItem(metadata, {
            runId: runState.runId,
            maker: maker.name,
          });
        }

        // Check global limit
        if (options.limit > 0 && runState.extracted >= options.limit) {
          log(
            `[ingest][${maker.name}] Global limit ${options.limit} reached, requesting stop`,
            'info'
          );
          runState.stopRequested = true;
          break;
        }
      } else {
        // All retries exhausted — track for post-Stage-1 retry phase
        summary.failedItems.push(item);
        log(`[ingest][${maker.name}] Failed to scrape ${item.code} — queued for post-ingest retry`, 'warn');
      }
    } catch (err) {
      log(
        `[ingest][${maker.name}] Skipping failed item ${item.code}: ${err.message}`,
        'warn'
      );
      summary.errors++;
      runState.errors++;
    }

    // ── Session rotation (mid-maker, for large makers) ──
    // Rotate every N items to keep __cf_bm bot score below Cloudflare threshold
    if (
      onSessionRotate &&
      summary.itemsExtracted > 0 &&
      summary.itemsExtracted % ROTATE_AFTER_ITEMS === 0 &&
      pendingCodes.length - (summary.itemsExtracted + summary.errors + summary.failedItems.length) > 0
    ) {
      log(
        `[ingest][${maker.name}] Mid-maker rotation after ${summary.itemsExtracted} items`,
        'info'
      );
      const newSession = await onSessionRotate(workerId);
      if (newSession) {
        scraper.workerSession = newSession.session;
        log(
          `[ingest][${maker.name}] Session rotated → ${newSession.session}`,
          'debug'
        );
      }
    }

    // Delay between items
    const itemDelay =
      Math.floor(Math.random() * (itemDelayMaxMs - itemDelayMinMs)) + itemDelayMinMs;
    await sleep(itemDelay);
  }

  log(
    `[ingest][${maker.name}] Done — pages=${summary.pagesScanned} listed=${summary.itemsListed} queued=${summary.itemsQueued} extracted=${summary.itemsExtracted} dupes=${summary.duplicatesSkipped} errors=${summary.errors}`,
    'info'
  );

  return summary;
}
