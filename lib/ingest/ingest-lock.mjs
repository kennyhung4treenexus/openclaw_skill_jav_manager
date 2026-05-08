/**
 * Ingest lock — prevent overlapping cron runs of Stage 01.
 * Pattern borrowed from Stage 03 verify-url lock.
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { log, getSkillPath, writeJsonAtomic, readJson } from '../shared.mjs';

export function getIngestLockPath() {
  return join(getSkillPath('cache'), 'ingest.lock');
}

/**
 * Try to acquire the ingest lock.
 * Returns true if acquired, false if another run is active.
 */
export function acquireIngestLock(lockPath, staleMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  if (existsSync(lockPath)) {
    try {
      const content = readJson(lockPath);
      if (content && content.pid && content.startedAt && (now - content.startedAt) < staleMs) {
        log(`[ingest] Lock exists (pid=${content.pid}, age=${((now - content.startedAt) / 1000) | 0}s) — skipping run`, 'info');
        return false;
      }
    } catch (_) {
      // stale or corrupt lock, proceed
    }
  }
  writeJsonAtomic(lockPath, { pid: process.pid, startedAt: now });
  return true;
}

/**
 * Release the ingest lock file.
 */
export function releaseIngestLock(lockPath) {
  try {
    if (existsSync(lockPath)) unlinkSync(lockPath);
  } catch (_) {}
}
