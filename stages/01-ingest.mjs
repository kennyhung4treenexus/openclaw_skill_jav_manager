/**
 * Stage 01: Ingest — Collect raw data from JavDB via FlareSolverr pool.
 *
 * Refactored: queue-based parallel maker workers with shared FlareSolverr pool,
 * per-item atomic cache, global dedupe, true limit, ingest lock.
 */

import { log, readJson, getSkillPath, sleep, parseFlaresolverrPorts, restartFlareSolverr } from '../lib/shared.mjs';
import { NotionClient } from '../lib/enrichers/notion-client.mjs';
import { FlareSolverrPool } from '../lib/net/flaresolverr-pool.mjs';
import { JavDBScraper } from '../lib/scrapers/javdb-scraper.mjs';
import { fetchExistingCodes } from '../lib/ingest/notion-code-index.mjs';
import { rebuildIngestIndex, writeMergedMetadata } from '../lib/ingest/item-store.mjs';
import { runMakerIngest } from '../lib/ingest/maker-runner.mjs';
import {
  acquireIngestLock,
  releaseIngestLock,
  getIngestLockPath,
} from '../lib/ingest/ingest-lock.mjs';
import { createRunState, createRunSummary, writeRunSummary } from '../lib/ingest/ingest-summary.mjs';

// ── Worker queue runner ─────────────────────────────────
async function runWorkers({ queue, workers, createWorker }) {
  let index = 0;
  const results = [];

  async function worker(workerId) {
    const workerContext = await createWorker(workerId);

    try {
      while (true) {
        const i = index++;
        if (i >= queue.length) return;
        const item = queue[i];
        results[i] = await workerContext.run(item);
      }
    } finally {
      if (workerContext?.close) {
        await workerContext.close();
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(workers, queue.length) }, (_, idx) => worker(idx + 1))
  );
  return results;
}

// ── Delay between maker dispatches ─────────────────────
const MAKER_DELAY_MIN_MS = 500;
const MAKER_DELAY_MAX_MS = 1500;

/**
 * Stage 1: Ingest
 */
export async function run(options = {}) {
  const {
    dryRun = false,
    verbose = false,
    limit = 0,
    workers: workersOption = undefined,
    maxPagesPerMaker = 5,
    downloadCovers = true,
  } = options;

  const workers = workersOption || parseInt(process.env.JAV_INGEST_WORKERS || '1', 10);

  log(`Starting Stage 1: Ingest (workers: ${workers}, limit: ${limit}, dryRun: ${dryRun})`, 'info');

  // ── Acquire lock ─────────────────────────────────────────
  const lockPath = getIngestLockPath();
  if (!acquireIngestLock(lockPath)) {
    return { stage: 'ingest', status: 'skipped', reason: 'lock held' };
  }

  let notion = null;

  try {
    // ── Init Notion ─────────────────────────────────────────
    notion = new NotionClient({ dryRun });
    await notion.initialize();

    // ── Fetch existing codes ────────────────────────────────
    const knownCodes = await fetchExistingCodes(
      dryRun ? null : notion.client
    );
    log(`Found ${knownCodes.size} existing codes in Notion`, 'info');

    // ── Load control files ──────────────────────────────────
    const config = readJson(getSkillPath('config.json'));
    const graveyard = readJson(getSkillPath('graveyard.json'));
    const { aliases, makers, filters, makerAliases } = config;

    // ── Restart FlareSolverr containers ─────────────────────
    const fsPorts = parseFlaresolverrPorts(process.env.JAV_FLARESOLVERR_PORTS);
    const clearVolumes = process.env.JAV_FLARESOLVERR_CLEAR_VOLUMES === 'true';

    const restartResult = await restartFlareSolverr(fsPorts, { clearVolumes });
    if (restartResult.errors.length > 0) {
      log(`[ingest] FlareSolverr restart warnings: ${restartResult.errors.join('; ')}`, 'warn');
    }
    if (restartResult.restarted === 0) {
      log('[ingest] FlareSolverr containers may not be running — pool may fail', 'warn');
    }

    // ── Init FlareSolverr pool ──────────────────────────────
    // Plan B v2: Simple pool with per-worker session rotation
    // Each worker sticks to one port; session rotates after every ~40 items
    const restartBetweenMakers = process.env.JAV_FLARESOLVERR_RESTART_BETWEEN_MAKERS !== 'false';

    const pool = new FlareSolverrPool({
      ports: fsPorts,
      maxTimeout: parseInt(process.env.JAV_FLARESOLVERR_TIMEOUT_MS || '60000', 10),
      warmupTimeout: 120000,
      cooldownMs: parseInt(process.env.JAV_FLARESOLVERR_COOLDOWN_MS || '300000', 10),
      requestDelayMs: parseInt(process.env.JAV_INGEST_ITEM_DELAY_MIN_MS || '8000', 10),
      maxFailStreak: 3,
      restartBetweenMakers,
      containerPrefix: process.env.JAV_FLARESOLVERR_CONTAINER_PREFIX || 'flaresolverr',
      session: `jav-ingest-${Date.now()}`,
      warmupUrl: 'https://javdb.com/',
    });
    await pool.initialize();

    // ── Create run state ────────────────────────────────────
    const runState = createRunState({ workers });
    runState.seenCodes = new Set(knownCodes);
    runState.healthyPorts = pool.healthyPorts;

    // ── Item store (imported inline for dry-run compatibility) ──
    const itemStore = { writeItem: (await import('../lib/ingest/item-store.mjs')).writeItem };

    // ── Maker queue ─────────────────────────────────────────
    const makerQueue = [...makers];

    // ── Worker options ──────────────────────────────────────
    const workerOptions = {
      maxPagesPerMaker,
      filters,
      dryRun,
      verbose,
      downloadCovers,
      limit,
      itemDelayMinMs: parseInt(process.env.JAV_INGEST_ITEM_DELAY_MIN_MS || '8000', 10),
      itemDelayMaxMs: parseInt(process.env.JAV_INGEST_ITEM_DELAY_MAX_MS || '10000', 10),
      pageDelayMinMs: parseInt(process.env.JAV_INGEST_PAGE_DELAY_MIN_MS || '4000', 10),
      pageDelayMaxMs: parseInt(process.env.JAV_INGEST_PAGE_DELAY_MAX_MS || '8000', 10),
    };

    // ── Run workers ─────────────────────────────────────────
    log(`Processing ${makerQueue.length} makers with ${workers} worker(s)...`, 'info');

    const makerSummaries = await runWorkers({
      queue: makerQueue,
      workers,
      createWorker: async (workerId) => {
        // Assign sticky port to worker
        const { port, session } = pool.assignWorker(workerId);

        const scraper = new JavDBScraper({
          aliases,
          graveyard,
          makerAliases,
          dryRun,
          verbose,
          flaresolverr: pool,
          workerPort: port,
          workerSession: session,
          enableBrowserSession: false,
        });
        await scraper.initialize();

        // Session rotation callback — used between makers and mid-maker for large makers
        const onSessionRotate = (async (wid) => {
          const result = await pool.rotateWorkerSession(wid);
          if (result) {
            scraper.workerSession = result.session;
            log(`[ingest] Worker ${wid} session rotated`, 'info');
          }
          return result;
        });

        return {
          run: async (maker) => {
            // Stagger maker starts slightly
            await sleep(
              Math.floor(Math.random() * (MAKER_DELAY_MAX_MS - MAKER_DELAY_MIN_MS)) + MAKER_DELAY_MIN_MS
            );

            // Rotate session before each maker (fresh __cf_bm cookie)
            await onSessionRotate(workerId);

            return runMakerIngest({
              maker,
              scraper,
              knownCodes,
              runState,
              itemStore,
              options: {
                ...workerOptions,
                workerId,
                // Pass rotation callback for mid-maker rotation (large makers)
                onSessionRotate: restartBetweenMakers ? onSessionRotate : null,
              },
            });
          },
          close: async () => {
            await scraper.close();
          },
        };
      },
    });

    // ── Post-Stage-1 retry phase: retry failed items ───────
    const allFailedItems = [];
    for (const s of makerSummaries) {
      if (s.failedItems && s.failedItems.length > 0) {
        allFailedItems.push(...s.failedItems);
      }
    }

    const permanentlyFailed = [];
    let recoveredCount = 0;

    if (allFailedItems.length > 0) {
      log(`[ingest] Post-ingest retry: ${allFailedItems.length} failed item(s) — retrying with fresh scraper…`, 'info');

      // Create a fresh scraper for the retry phase
      const retryScraper = new JavDBScraper({
        aliases,
        graveyard,
        makerAliases,
        dryRun,
        verbose,
        flaresolverr: pool,
        enableBrowserSession: false,
      });

      // Retry each failed item up to 3 more times
      for (const item of allFailedItems) {
        try {
          const metadata = await retryScraper.scrapeItem(item);

          if (metadata) {
            // Success on retry — save to cache
            recoveredCount++;
            runState.extracted++;

            if (!dryRun) {
              if (downloadCovers) {
                try {
                  await retryScraper.downloadCover(metadata);
                } catch (coverErr) {
                  log(`[ingest] Retry cover failed for ${item.code}: ${coverErr.message}`, 'warn');
                }
              }
              await itemStore.writeItem(metadata, {
                runId: runState.runId,
                maker: metadata.maker || 'unknown',
              });
            }
            log(`[ingest] Retry success: ${item.code} recovered!`, 'info');
          } else {
            // Still failing — permanently failed
            permanentlyFailed.push({ code: item.code, url: item.url });
            log(`[ingest] Retry exhausted: ${item.code} permanently failed`, 'warn');
          }

          // Delay between retries
          const retryDelay =
            Math.floor(Math.random() * (workerOptions.itemDelayMaxMs - workerOptions.itemDelayMinMs)) +
            workerOptions.itemDelayMinMs;
          await sleep(retryDelay);

        } catch (err) {
          permanentlyFailed.push({ code: item.code, url: item.url });
          log(`[ingest] Retry error for ${item.code}: ${err.message}`, 'error');
        }
      }

      await retryScraper.close();

      log(
        `[ingest] Post-ingest retry done — recovered=${recoveredCount} permanent=${permanentlyFailed.length}`,
        'info'
      );
    }

    // ── Save permanently failed items ────────────────────
    if (!dryRun && permanentlyFailed.length > 0) {
      const failedPath = getSkillPath('cache/ingest/permanently-failed.json');
      const { writeFileSync } = await import('fs');
      writeFileSync(failedPath, JSON.stringify(permanentlyFailed, null, 2));
      log(`[ingest] Saved ${permanentlyFailed.length} permanently failed items to cache/ingest/permanently-failed.json`, 'warn');
    }

    // ── Rebuild index & merge metadata ───────────────────
    if (!dryRun) {
      await rebuildIngestIndex();
      await writeMergedMetadata();
    }

    // ── Summary ────────────────────────────────────────────
    const summary = createRunSummary(runState, makerSummaries);
    summary.postRetryRecovered = recoveredCount;
    summary.permanentlyFailed = permanentlyFailed.length;
    await writeRunSummary(summary);

    log(
      `[ingest] Done — extracted=${summary.itemsExtracted} dupes=${summary.duplicatesSkipped} errors=${summary.errors} recovered=${recoveredCount} permanentFail=${permanentlyFailed.length} duration=${Math.round(summary.durationMs / 1000)}s`,
      'info'
    );

    return { stage: 'ingest', status: 'completed', ...summary };

  } catch (error) {
    log(`Fatal error: ${error.message}`, 'error');
    throw error;
  } finally {
    // ── Cleanup ────────────────────────────────────────────
    if (notion) {
      try {
        await notion.close();
      } catch {}
    }

    releaseIngestLock(lockPath);
  }
}
