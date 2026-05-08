/**
 * Stage 7: Delete — Safe Pipeline Cleanup
 *
 * Responsibilities:
 *   1.  Delete cache/ingest/metadata.json
 *   2.  Delete cache/ingest/covers/*.jpg
 *   3.  Delete cache/ingest/items/*.json  (per-item atomic caches)
 *   4.  Delete cache/ingest/index.json     (rebuildable index)
 *   5.  Prune cache/ingest/runs/*.json     (old run summaries, age-based)
 *   6.  Prune cache/test-artifacts/*.json  (rankings test/debug artifacts, age-based)
 *   7.  Prune *-summary.json files         (enrich/rankings/notify/delete, age-based)
 *   8.  Clean old log files                (>30 days, age-based)
 *   9.  Delete empty directories under cache/
 *  10.  Kill orphan chromium processes     (crashed browser runs)
 *  11.  Prune recycle bin                  (.trash/ older than 7 days)
 *
 * Safety:
 *   - dry-run by default; must explicitly pass dryRun=false to execute
 *   - Active pipeline lock guard: aborts if ingest or verify-url lock is active
 *   - Protected files list prevents accidental deletion of persistent state
 *   - Recycle bin (.trash/) for 7-day soft-delete window
 *   - Only kills chromium processes owned by the current user
 *
 * Testing:
 *   - Pass { skillRoot: '/tmp/test-root' } to resolve all paths under a sandbox
 */

import { getSkillPath, writeJsonAtomic, log } from '../lib/shared.mjs';
import {
  existsSync, readdirSync, unlinkSync, statSync,
  mkdirSync, renameSync, rmdirSync
} from 'fs';
import { join, dirname, basename } from 'path';
import { execSync } from 'child_process';

// ---------------------------------------------------------------------------
// Configurable retention defaults (overridable via env)
// ---------------------------------------------------------------------------

function envDays(key, defaultDays) {
  const val = process.env[key];
  if (val === undefined || val === '') return defaultDays;
  const n = parseInt(val, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultDays;
}

function getRetention() {
  return {
    LOG:      envDays('JAV_CLEANUP_LOG_RETENTION_DAYS', 30),
    ARTIFACT: envDays('JAV_CLEANUP_ARTIFACT_RETENTION_DAYS', 7),
    RUN:      envDays('JAV_CLEANUP_RUN_RETENTION_DAYS', 90),
    SUMMARY:  envDays('JAV_CLEANUP_SUMMARY_RETENTION_DAYS', 30),
    TRASH:    envDays('JAV_CLEANUP_TRASH_RETENTION_DAYS', 7),
  };
}



const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR   = 60 * MINUTE;
const DAY    = 24 * HOUR;

// ---------------------------------------------------------------------------
// Protected files — must never be deleted by Stage 7
// ---------------------------------------------------------------------------
const PROTECTED_PATTERNS = [
  /cache\/url-health\.json$/,
  /cache\/daily_snapshot\.json$/,
  /cache\/weekly_snapshot\.json$/,
  /cache\/monthly_snapshot\.json$/,
  /cache\/triple_crown_snapshot\.json$/,
  /cache\/notified_codes\.json$/,
  /session\/cookies\.json$/,
  /config\.json$/,
  /\.env$/,
];

function isProtected(absPath, resolvePath) {
  // Resolve skill root to get relative path
  // The protected patterns are relative to the skill root
  const skillRoot = resolvePath('.');
  const rel = absPath.startsWith(skillRoot)
    ? absPath.slice(skillRoot.length).replace(/^\/+/, '')
    : absPath;
  return PROTECTED_PATTERNS.some(p => p.test(rel));
}

// ---------------------------------------------------------------------------
// Lock staleness check
// ---------------------------------------------------------------------------
const LOCK_STALE_MS = 6 * HOUR;

function isLockActive(lockPath) {
  if (!existsSync(lockPath)) return false;
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    return age < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Trash manager — recycle bin for soft-delete
// ---------------------------------------------------------------------------
function trashFile(filePath, resolvePath, dryRun) {
  const trashRoot = join(resolvePath('cache'), '.trash');

  if (dryRun) {
    return join(trashRoot, basename(filePath));
  }

  if (!existsSync(trashRoot)) {
    mkdirSync(trashRoot, { recursive: true });
  }

  const ts = Date.now();
  const dest = join(trashRoot, `${basename(filePath)}.${ts}`);
  renameSync(filePath, dest);
  return dest;
}

function pruneTrash(resolvePath, maxAgeMs, dryRun) {
  const trashDir = join(resolvePath('cache'), '.trash');
  if (!existsSync(trashDir)) return { pruned: 0, remaining: 0 };

  let pruned = 0;
  const now = Date.now();
  const entries = readdirSync(trashDir);

  for (const entry of entries) {
    const entryPath = join(trashDir, entry);
    // Parse timestamp from filename pattern: <basename>.<timestamp>
    // e.g. metadata.json.1748567890123
    const dotIdx = entry.lastIndexOf('.');
    let age;
    if (dotIdx > 0) {
      const ts = parseInt(entry.slice(dotIdx + 1), 10);
      if (Number.isFinite(ts) && ts > 1e12) {
        // Valid timestamp embedded in filename — use that instead of mtime
        age = now - ts;
      } else {
        // Fallback to mtime if timestamp not parsable
        try { age = now - statSync(entryPath).mtimeMs; } catch { continue; }
      }
    } else {
      try { age = now - statSync(entryPath).mtimeMs; } catch { continue; }
    }

    if (age >= maxAgeMs) {
      if (!dryRun) {
        try {
          const s = statSync(entryPath);
          if (s.isDirectory()) {
            rmdirSync(entryPath, { recursive: true });
          } else {
            unlinkSync(entryPath);
          }
        } catch (e) {
          log(`[delete] Failed to delete trash entry ${entry}: ${e.message}`, 'warn');
        }
      }
      pruned++;
    }
  }

  const remaining = readdirSync(trashDir).length;

  if (pruned > 0) {
    log(
      `[delete] Pruned ${pruned} stale item(s) from .trash/ (kept ${remaining})`,
      'info'
    );
  }

  return { pruned, remaining };
}

// ---------------------------------------------------------------------------
// Age-based file pruning helper
// ---------------------------------------------------------------------------
function pruneFilesByAge(dirPath, maxAgeMs, label, resolvePath, dryRun, skipped) {
  if (!existsSync(dirPath)) return { deleted: 0, skipped };

  let deleted = 0;
  const now = Date.now();
  const files = readdirSync(dirPath);

  for (const file of files) {
    const filePath = join(dirPath, file);
    let s;
    try { s = statSync(filePath); } catch { continue; }
    if (!s.isFile()) continue;

    if (isProtected(filePath, resolvePath)) {
      skipped.push({ path: filePath, reason: 'protected' });
      continue;
    }

    const age = now - s.mtimeMs;
    if (age > maxAgeMs) {
      if (dryRun) {
        log(
          `[delete] [DRY] Would delete: ${label}/${file} (${Math.round(age / DAY)}d old)`,
          'info'
        );
      } else {
        trashFile(filePath, resolvePath, false);
        deleted++;
      }
    }
  }

  return { deleted, skipped };
}

// ---------------------------------------------------------------------------
// Bulk delete all files matching extension
// ---------------------------------------------------------------------------
function cleanDirectory(dirPath, extension, label, resolvePath, dryRun, skipped) {
  if (!existsSync(dirPath)) return { deleted: 0, skipped };

  let deleted = 0;
  const files = readdirSync(dirPath).filter(f => f.endsWith(extension));

  for (const file of files) {
    const filePath = join(dirPath, file);
    if (isProtected(filePath, resolvePath)) {
      skipped.push({ path: filePath, reason: 'protected' });
      continue;
    }
    if (dryRun) {
      log(`[delete] [DRY] Would delete: ${label}/${file}`, 'info');
    } else {
      trashFile(filePath, resolvePath, false);
      deleted++;
    }
  }

  return { deleted, skipped };
}

// ---------------------------------------------------------------------------
// Safe single-file delete
// ---------------------------------------------------------------------------
function safeDelete(filePath, label, resolvePath, dryRun, skipped) {
  if (!existsSync(filePath)) return { deleted: false, skipped };

  if (isProtected(filePath, resolvePath)) {
    skipped.push({ path: filePath, reason: 'protected' });
    return { deleted: false, skipped };
  }

  if (dryRun) {
    log(`[delete] [DRY] Would delete: ${label} (${filePath})`, 'info');
    return { deleted: false, skipped };
  }

  trashFile(filePath, resolvePath, false);
  log(`[delete] Deleted: ${label} (${filePath})`, 'info');
  return { deleted: true, skipped };
}

// ---------------------------------------------------------------------------
// Empty directory cleanup
// ---------------------------------------------------------------------------
function cleanEmptyDirs(rootDir, dryRun) {
  if (!existsSync(rootDir)) return 0;

  let count = 0;

  try {
    const output = execSync(
      `find "${rootDir}" -type d -empty 2>/dev/null`,
      { encoding: 'utf8', timeout: 5000 }
    ).trim();

    if (!output) return 0;

    const dirs = output.split('\n').filter(Boolean).reverse();

    for (const dirPath of dirs) {
      if (dryRun) {
        log(`[delete] [DRY] Would remove empty directory: ${dirPath}`, 'info');
        count++;
      } else {
        try {
          rmdirSync(dirPath);
          count++;
        } catch (e) {
          log(`[delete] Failed to remove empty dir ${dirPath}: ${e.message}`, 'warn');
        }
      }
    }
  } catch {
    // find may fail if dir doesn't exist
  }

  return count;
}

// ---------------------------------------------------------------------------
// Orphan chromium kill
// ---------------------------------------------------------------------------
/**
 * Kill orphan Chromium / Puppeteer processes that were started by JAV manager.
 * Narrow detection to avoid killing the user's own Chrome browser:
 *   - Match "playwright" (used by JAV manager's puppeteer-real-browser)
 *   - Match "puppeteer" or "rebrowser"
 *   - Match headless chrome with known port patterns
 */
function killOrphanChromium(dryRun) {
  // Patterns that identify JAV-manager-started chrome processes
  const searchPatterns = [
    'playwright.*chromium',
    'puppeteer',
    'rebrowser',
    'chrome.*--remote-debugging-port=819[0-9]',
    'chrome.*headless.*jav',
  ];

  if (dryRun) {
    for (const pat of searchPatterns) {
      try {
        const result = execSync(
          `pgrep -u $(whoami) -c -f "${pat}" 2>/dev/null || echo 0`,
          { encoding: 'utf8' }
        ).trim();
        const n = parseInt(result, 10) || 0;
        if (n > 0) {
          log(`[delete] [DRY] Found ${n} process(es) matching "${pat}", would kill`, 'info');
        }
      } catch {}
    }
    return 0;
  }

  let killed = 0;

  for (const pat of searchPatterns) {
    try {
      const pids = execSync(
        `pgrep -u $(whoami) -f "${pat}" 2>/dev/null || true`,
        { encoding: 'utf8' }
      ).trim();

      if (!pids) continue;

      const pidList = pids.split('\n').filter(Boolean);
      for (const pid of pidList) {
        try {
          process.kill(parseInt(pid), 'SIGTERM');
          killed++;
          log(`[delete] Killed orphan process: PID ${pid} (${pat})`, 'info');
        } catch (e) {
          log(`[delete] Failed to kill PID ${pid}: ${e.message}`, 'warn');
        }
      }
    } catch {}
  }

  if (killed > 0) {
    execSync('sleep 2');
    for (const pat of searchPatterns) {
      try {
        execSync(
          `pkill -u $(whoami) -9 -f "${pat}" 2>/dev/null || true`,
          { encoding: 'utf8' }
        );
      } catch {}
    }
  }

  return killed;
}

// ---------------------------------------------------------------------------
// Log retention helper
// ---------------------------------------------------------------------------
function cleanOldLogs(logsDir, maxAgeMs, resolvePath, dryRun, skipped) {
  if (!existsSync(logsDir)) return { deleted: 0, skipped };

  let deleted = 0;
  const now = Date.now();
  const files = readdirSync(logsDir).filter(f => f.endsWith('.log'));

  for (const file of files) {
    const filePath = join(logsDir, file);
    let s;
    try { s = statSync(filePath); } catch { continue; }

    if (isProtected(filePath, resolvePath)) {
      skipped.push({ path: filePath, reason: 'protected' });
      continue;
    }

    const age = now - s.mtimeMs;
    if (age > maxAgeMs) {
      if (dryRun) {
        log(`[delete] [DRY] Would delete: logs/${file} (${Math.round(age / DAY)}d old)`, 'info');
      } else {
        trashFile(filePath, resolvePath, false);
        deleted++;
      }
    }
  }

  return { deleted, skipped };
}

// ---------------------------------------------------------------------------
// Save dry-run preview JSON
// ---------------------------------------------------------------------------
function saveDryRunPreview(resolvePath, preview) {
  const previewFile = join(resolvePath('cache'), 'cleanup-preview.json');
  try {
    writeJsonAtomic(previewFile, {
      dryRun: true,
      generatedAt: new Date().toISOString(),
      ...preview,
    });
    log(`[delete] Dry-run preview saved: cache/cleanup-preview.json`, 'info');
  } catch (e) {
    log(`[delete] Failed to save dry-run preview: ${e.message}`, 'warn');
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function run(options = {}) {
  const { dryRun = true, skillRoot } = options;

  // Build the path resolver: injectable root for testing, or real skill root
  const resolvePath = skillRoot
    ? (rel) => join(skillRoot, rel)
    : getSkillPath;

  log(`[delete] Starting — dryRun=${dryRun}`, 'info');

  // ── Active pipeline guard ──────────────────────────────────────────────
  const ingestLock = resolvePath('cache/ingest.lock');
  const verifyLock = resolvePath('cache/verify-url.lock');

  if (isLockActive(ingestLock) || isLockActive(verifyLock)) {
    const reasons = [];
    if (isLockActive(ingestLock)) reasons.push('ingest.lock is active');
    if (isLockActive(verifyLock)) reasons.push('verify-url.lock is active');
    const msg = `Pipeline lock(s) active — aborting cleanup (${reasons.join(', ')})`;
    log(`[delete] ${msg}`, 'warn');

    const summary = {
      stage: '07-delete',
      status: 'aborted',
      reason: msg,
      dryRun: !!dryRun,
      runAt: new Date().toISOString(),
    };

    try {
      writeJsonAtomic(resolvePath('cache/delete-summary.json'), summary);
    } catch (e) {
      log(`[delete] Failed to write summary: ${e.message}`, 'warn');
    }

    return summary;
  }

  // ── Stats collectors ──────────────────────────────────────────────────
  const skipped = [];
  const stats = {
    filesDeleted: 0,
    coversDeleted: 0,
    itemsDeleted: 0,
    indexDeleted: 0,
    runsDeleted: 0,
    artifactsDeleted: 0,
    summariesDeleted: 0,
    logsDeleted: 0,
    processesKilled: 0,
    emptyDirsRemoved: 0,
    trashPruned: 0,
    errors: [],
  };

  try {
    // ── 1. Metadata.json ────────────────────────────────────────────────
    {
      const result = safeDelete(
        resolvePath('cache/ingest/metadata.json'),
        'metadata.json', resolvePath, dryRun, skipped
      );
      if (result.deleted) stats.filesDeleted++;
    }

    // ── 2. Covers ────────────────────────────────────────────────────────
    {
      const result = cleanDirectory(
        resolvePath('cache/ingest/covers'), '.jpg',
        'covers', resolvePath, dryRun, skipped
      );
      stats.coversDeleted = result.deleted;
    }

    // ── 3. Items ─────────────────────────────────────────────────────────
    {
      const result = cleanDirectory(
        resolvePath('cache/ingest/items'), '.json',
        'items', resolvePath, dryRun, skipped
      );
      stats.itemsDeleted = result.deleted;
    }

    // ── 4. Index.json ────────────────────────────────────────────────────
    {
      const result = safeDelete(
        resolvePath('cache/ingest/index.json'),
        'index.json', resolvePath, dryRun, skipped
      );
      if (result.deleted) stats.indexDeleted++;
    }

    // ── 5. Old run summaries ─────────────────────────────────────────────
    {
      const result = pruneFilesByAge(
        resolvePath('cache/ingest/runs'),
        getRetention().RUN * DAY, 'runs', resolvePath, dryRun, skipped
      );
      stats.runsDeleted = result.deleted;
    }

    // ── 6. Old test artifacts ────────────────────────────────────────────
    {
      const result = pruneFilesByAge(
        resolvePath('cache/test-artifacts'),
        getRetention().ARTIFACT * DAY, 'test-artifacts', resolvePath, dryRun, skipped
      );
      stats.artifactsDeleted = result.deleted;
    }

    // ── 7. Old summary files ─────────────────────────────────────────────
    {
      let deleted = 0;
      const now = Date.now();
      const cacheDir = resolvePath('cache');
      const files = existsSync(cacheDir) ? readdirSync(cacheDir) : [];

      for (const file of files) {
        if (!file.endsWith('-summary.json')) continue;
        const filePath = join(cacheDir, file);
        let s;
        try { s = statSync(filePath); } catch { continue; }
        if (!s.isFile()) continue;

        if (isProtected(filePath, resolvePath)) {
          skipped.push({ path: filePath, reason: 'protected' });
          continue;
        }

        const age = now - s.mtimeMs;
        if (age > getRetention().SUMMARY * DAY) {
          if (dryRun) {
            log(`[delete] [DRY] Would delete: ${file} (${Math.round(age / DAY)}d old)`, 'info');
          } else {
            trashFile(filePath, resolvePath, false);
            deleted++;
          }
        }
      }
      stats.summariesDeleted = deleted;
    }

    // ── 8. Old logs ─────────────────────────────────────────────────────
    {
      const result = cleanOldLogs(
        resolvePath('logs'),
        getRetention().LOG * DAY, resolvePath, dryRun, skipped
      );
      stats.logsDeleted = result.deleted;
    }

    // ── 9. Empty directories under cache/ ────────────────────────────────
    {
      stats.emptyDirsRemoved = cleanEmptyDirs(resolvePath('cache'), dryRun);
    }

    // ── 10. Orphan chromium ──────────────────────────────────────────────
    {
      stats.processesKilled = killOrphanChromium(dryRun);
    }

    // ── 11. Prune recycle bin ──────────────────────────────────────────
    {
      const result = pruneTrash(resolvePath, getRetention().TRASH * DAY, dryRun);
      stats.trashPruned = result.pruned;
    }

  } catch (e) {
    log(`[delete] Unexpected error: ${e.message}`, 'error');
    stats.errors.push(e.message);
  }

  // ── Post-run protected file verification ─────────────────────────────
  {
    const protectedFiles = [
      resolvePath('cache/url-health.json'),
      resolvePath('cache/daily_snapshot.json'),
      resolvePath('cache/weekly_snapshot.json'),
      resolvePath('cache/monthly_snapshot.json'),
      resolvePath('cache/triple_crown_snapshot.json'),
      resolvePath('cache/notified_codes.json'),
    ];
    const verified = [];
    for (const pf of protectedFiles) {
      if (existsSync(pf)) {
        verified.push(pf);
      }
    }
    stats.protectedFilesVerified = verified.length;
  }

  // ── Save dry-run preview ─────────────────────────────────────────────
  if (dryRun) {
    saveDryRunPreview(resolvePath, { skipped, stats });
  }

  // ── Summary ───────────────────────────────────────────────────────────
  const summary = {
    stage: '07-delete',
    status: stats.errors.length > 0 ? 'partial' : 'completed',
    ...stats,
    skipped: skipped.length > 0 ? skipped : undefined,
    dryRun: !!dryRun,
    runAt: new Date().toISOString(),
  };

  try {
    writeJsonAtomic(resolvePath('cache/delete-summary.json'), summary);
  } catch {}

  log(
    `[delete] Done — ` +
    `files=${stats.filesDeleted} covers=${stats.coversDeleted} ` +
    `items=${stats.itemsDeleted} index=${stats.indexDeleted} ` +
    `runs=${stats.runsDeleted} artifacts=${stats.artifactsDeleted} ` +
    `summaries=${stats.summariesDeleted} logs=${stats.logsDeleted} ` +
    `chromium=${stats.processesKilled} dirs=${stats.emptyDirsRemoved} protected=${stats.protectedFilesVerified} ` +
    `trash=${stats.trashPruned} errors=${stats.errors.length}`,
    'info'
  );

  return summary;
}

// ---------------------------------------------------------------------------
// Module config
// ---------------------------------------------------------------------------
export const config = {
  name: '07-delete',
  description:
    'Pipeline cleanup: temp files, old cache, stale crown history, ' +
    'orphan processes, recycle bin',
  dependencies: ['06-notify'],
};
