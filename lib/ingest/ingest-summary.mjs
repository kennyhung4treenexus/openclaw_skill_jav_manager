/**
 * Ingest summary — record run results for observability.
 *
 * Output: cache/ingest/runs/<runId>.json
 */

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { log, getSkillPath, writeJsonAtomic } from '../shared.mjs';

const RUNS_DIR = () => getSkillPath('cache/ingest/runs');

/**
 * Create a run summary object.
 * @param {object} runState
 * @param {Array<object>} makerSummaries
 * @returns {object}
 */
export function createRunSummary(runState, makerSummaries) {
  const now = new Date().toISOString();
  const activeMakerSummaries = makerSummaries.filter((m) =>
    (m.pagesScanned || 0) > 0 ||
    (m.itemsListed || 0) > 0 ||
    (m.itemsQueued || 0) > 0 ||
    (m.itemsExtracted || 0) > 0 ||
    (m.duplicatesSkipped || 0) > 0 ||
    (m.errors || 0) > 0 ||
    !!m.stoppedOnKnown
  );

  return {
    runId: runState.runId,
    startedAt: runState.startedAt,
    finishedAt: now,
    durationMs: Date.now() - new Date(runState.startedAt).getTime(),
    workers: runState.workers,
    makersProcessed: activeMakerSummaries.length,
    pagesScanned: makerSummaries.reduce((s, m) => s + (m.pagesScanned || 0), 0),
    itemsListed: makerSummaries.reduce((s, m) => s + (m.itemsListed || 0), 0),
    itemsQueued: makerSummaries.reduce((s, m) => s + (m.itemsQueued || 0), 0),
    itemsExtracted: runState.extracted,
    duplicatesSkipped: runState.duplicatesSkipped,
    errors: runState.errors,
    healthyFlaresolverrPorts: runState.healthyPorts || [],
    makerDetails: makerSummaries,
  };
}

/**
 * Write run summary to cache/ingest/runs/<runId>.json
 * @param {object} summary
 */
export async function writeRunSummary(summary) {
  if (!summary?.runId) return;

  const runsDir = RUNS_DIR();
  try {
    if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });

    const filePath = join(runsDir, `${summary.runId}.json`);
    writeJsonAtomic(filePath, summary);
    log(`[ingest-summary] Wrote run summary to ${filePath}`, 'info');
  } catch (error) {
    log(`[ingest-summary] Failed to write summary: ${error.message}`, 'error');
  }
}

/**
 * Create initial run state.
 * @param {object} options
 * @returns {object}
 */
export function createRunState(options = {}) {
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  return {
    runId,
    startedAt: new Date().toISOString(),
    extracted: 0,
    duplicatesSkipped: 0,
    errors: 0,
    stopRequested: false,
    seenCodes: new Set(),
    workers: options.workers || 1,
    healthyPorts: [],
  };
}
