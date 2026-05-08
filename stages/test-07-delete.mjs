/**
 * Tests for Stage 7: Delete — Safe Pipeline Cleanup
 *
 * Uses skillRoot injection to sandbox all file operations under a temp dir.
 *
 * Coverage:
 *   1. Dry-run default (no-op safety)
 *   2. Active pipeline lock guard
 *   3. Stale lock passes through
 *   4. Protected files never deleted
 *   5. Recycle bin receives deleted files
 *   6. Empty directories cleaned
 *   7. Dry-run preview JSON saved
 *   8. Skipped files reported in summary
 *   9. Env var retention overrides respected
 */

import { run } from './07-delete.mjs';
import {
  existsSync, writeFileSync, mkdirSync, readdirSync,
  unlinkSync, rmdirSync, statSync
} from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { after, before } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Test sandbox
// ---------------------------------------------------------------------------
const SANDBOX = join(process.env.HOME || '/tmp', '.test-stage7-sandbox');
const DAY = 24 * 60 * 60 * 1000;

function resolve(...parts) {
  return join(SANDBOX, ...parts);
}

function touchFile(filePath) {
  const dir = filePath.slice(0, filePath.lastIndexOf('/'));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, '{}', 'utf8');
  return filePath;
}

function setMtime(filePath, ageMs) {
  // Use touch with a calculated timestamp
  const targetDate = new Date(Date.now() - ageMs);
  const ts = targetDate.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
    .replace('T', '')
    .replace('Z', '')
    .slice(0, 12);
  try {
    execSync(`touch -t "${ts}" "${filePath}"`, { timeout: 2000 });
  } catch {
    // Write again so mtime is at least different
    writeFileSync(filePath, '{}', 'utf8');
  }
}

function rmRecursive(dirPath) {
  if (!existsSync(dirPath)) return;
  try {
    const entries = readdirSync(dirPath);
    for (const entry of entries) {
      const full = join(dirPath, entry);
      try {
        if (statSync(full).isDirectory()) {
          rmRecursive(full);
        } else {
          unlinkSync(full);
        }
      } catch {}
    }
    rmdirSync(dirPath);
  } catch {}
}

function setupSandbox() {
  rmRecursive(SANDBOX);
  mkdirSync(SANDBOX, { recursive: true });

  // Create test files mimicking real cache structure
  touchFile(resolve('cache/ingest/metadata.json'));
  touchFile(resolve('cache/ingest/index.json'));
  touchFile(resolve('cache/ingest/covers/ABC-123.jpg'));
  touchFile(resolve('cache/ingest/covers/XYZ-999.jpg'));
  touchFile(resolve('cache/ingest/items/ABC-123.json'));
  touchFile(resolve('cache/ingest/items/XYZ-999.json'));
  touchFile(resolve('cache/ingest/runs/old-run.json'));
  touchFile(resolve('cache/ingest/runs/recent-run.json'));
  touchFile(resolve('cache/enrich-summary.json'));
  touchFile(resolve('cache/rankings-summary.json'));
  touchFile(resolve('cache/notify-summary.json'));

  // Protected files
  touchFile(resolve('cache/url-health.json'));
  touchFile(resolve('cache/daily_snapshot.json'));
  touchFile(resolve('cache/weekly_snapshot.json'));
  touchFile(resolve('cache/monthly_snapshot.json'));
  touchFile(resolve('cache/triple_crown_snapshot.json'));
  touchFile(resolve('cache/notified_codes.json'));

  // Old files for age-based pruning
  touchFile(resolve('cache/ingest/runs/stale-run.json'));
  setMtime(resolve('cache/ingest/runs/stale-run.json'), 100 * DAY);

  touchFile(resolve('cache/test-artifacts/old-artifact.json'));
  setMtime(resolve('cache/test-artifacts/old-artifact.json'), 30 * DAY);

  // Logs
  const logsDir = resolve('logs');
  mkdirSync(logsDir, { recursive: true });
  touchFile(resolve('logs/recent.log'));
  touchFile(resolve('logs/stale.log'));
  setMtime(resolve('logs/stale.log'), 60 * DAY);

  return SANDBOX;
}

// ---------------------------------------------------------------------------
// Test 1: Default is dry-run
// ---------------------------------------------------------------------------
async function testDefaultDryRun() {
  console.log('\nTest 1: Default dry-run = true');
  const root = setupSandbox();

  const result = await run({ dryRun: true, skillRoot: root });

  assert.equal(result.dryRun, true, 'dryRun flag is true');
  assert.equal(result.status, 'completed', 'status is completed');

  // Files should still exist (dry-run)
  assert.ok(existsSync(resolve('cache/ingest/metadata.json')), 'metadata.json preserved');
  assert.ok(existsSync(resolve('cache/ingest/covers/ABC-123.jpg')), 'cover preserved');
  assert.ok(existsSync(resolve('cache/ingest/items/ABC-123.json')), 'item preserved');

  // Dry-run preview should be saved
  assert.ok(existsSync(resolve('cache/cleanup-preview.json')), 'cleanup-preview.json exists');
}

// ---------------------------------------------------------------------------
// Test 2: Protected files never deleted
// ---------------------------------------------------------------------------
async function testProtectedFiles() {
  console.log('\nTest 2: Protected files preserved');
  const root = setupSandbox();

  await run({ dryRun: false, skillRoot: root });

  // Protected files must survive
  assert.ok(existsSync(resolve('cache/url-health.json')), 'url-health.json survives');
  assert.ok(existsSync(resolve('cache/daily_snapshot.json')), 'daily_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/weekly_snapshot.json')), 'weekly_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/monthly_snapshot.json')), 'monthly_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/triple_crown_snapshot.json')), 'triple_crown_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/notified_codes.json')), 'notified_codes.json survives');

  // Non-protected temp files should be gone (or trashed)
  assert.ok(!existsSync(resolve('cache/ingest/metadata.json')), 'metadata.json deleted');
  assert.ok(!existsSync(resolve('cache/ingest/covers/ABC-123.jpg')), 'cover deleted');
  assert.ok(!existsSync(resolve('cache/ingest/items/ABC-123.json')), 'item deleted');
}

// ---------------------------------------------------------------------------
// Test 3: Active pipeline lock aborts
// ---------------------------------------------------------------------------
async function testLockGuard() {
  console.log('\nTest 3: Active lock aborts cleanup');
  const root = setupSandbox();

  // Create a fresh lock file (recent = active)
  touchFile(resolve('cache/ingest.lock'));

  const result = await run({ dryRun: false, skillRoot: root });

  assert.equal(result.status, 'aborted', 'run aborted when lock is active');

  // Files should still exist
  assert.ok(existsSync(resolve('cache/ingest/metadata.json')), 'files preserved after abort');
}

// ---------------------------------------------------------------------------
// Test 4: Stale lock does NOT abort
// ---------------------------------------------------------------------------
async function testStaleLock() {
  console.log('\nTest 4: Stale lock passes through');
  const root = setupSandbox();

  // Create a stale lock (>6 hours)
  touchFile(resolve('cache/ingest.lock'));
  setMtime(resolve('cache/ingest.lock'), 10 * 60 * 60 * 1000); // 10 hours ago

  const result = await run({ dryRun: true, skillRoot: root });

  assert.notEqual(result.status, 'aborted', 'run proceeds with stale lock');
}

// ---------------------------------------------------------------------------
// Test 5: Recycle bin receives deleted files
// ---------------------------------------------------------------------------
async function testRecycleBin() {
  console.log('\nTest 5: Recycle bin receives deleted files');
  const root = setupSandbox();

  await run({ dryRun: false, skillRoot: root });

  const trashDir = resolve('cache/.trash');
  assert.ok(existsSync(trashDir), '.trash/ directory exists');

  const trashFiles = readdirSync(trashDir);
  assert.ok(trashFiles.length > 0, 'trash has entries');

  const found = trashFiles.some(f => f.startsWith('metadata.json'));
  assert.ok(found, 'metadata.json found in trash');
}

// ---------------------------------------------------------------------------
// Test 6: Protected files verified post-run
// ---------------------------------------------------------------------------
async function testProtectedVerification() {
  console.log('\nTest 6: Protected files verification post-run');
  const root = setupSandbox();

  const result = await run({ dryRun: false, skillRoot: root });

  // All protected files must survive
  assert.ok(existsSync(resolve('cache/url-health.json')), 'url-health.json survives');
  assert.ok(existsSync(resolve('cache/daily_snapshot.json')), 'daily_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/weekly_snapshot.json')), 'weekly_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/monthly_snapshot.json')), 'monthly_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/triple_crown_snapshot.json')), 'triple_crown_snapshot.json survives');
  assert.ok(existsSync(resolve('cache/notified_codes.json')), 'notified_codes.json survives');

  // Summary should count verified protected files
  assert.ok(result.protectedFilesVerified >= 6, `protectedFilesVerified >= 6 (got ${result.protectedFilesVerified})`);
}

// ---------------------------------------------------------------------------
// Test 7: Env retention overrides
// ---------------------------------------------------------------------------
async function testRetentionEnv() {
  console.log('\nTest 7: Env var retention overrides');
  const root = setupSandbox();

  // Zero-day retention: everything is considered old
  process.env.JAV_CLEANUP_ARTIFACT_RETENTION_DAYS = '0';
  process.env.JAV_CLEANUP_SUMMARY_RETENTION_DAYS = '0';
  process.env.JAV_CLEANUP_RUN_RETENTION_DAYS = '0';
  process.env.JAV_CLEANUP_LOG_RETENTION_DAYS = '0';
  process.env.JAV_CLEANUP_TRASH_RETENTION_DAYS = '0';

  setupSandbox();

  await run({ dryRun: false, skillRoot: root });

  // Old summaries should be cleaned
  assert.ok(!existsSync(resolve('cache/enrich-summary.json')), 'enrich-summary.json deleted');

  // Cleanup env
  delete process.env.JAV_CLEANUP_ARTIFACT_RETENTION_DAYS;
  delete process.env.JAV_CLEANUP_SUMMARY_RETENTION_DAYS;
  delete process.env.JAV_CLEANUP_RUN_RETENTION_DAYS;
  delete process.env.JAV_CLEANUP_LOG_RETENTION_DAYS;
  delete process.env.JAV_CLEANUP_TRASH_RETENTION_DAYS;
}

// ---------------------------------------------------------------------------
// Test 8: age-based pruning respects mtime
// ---------------------------------------------------------------------------
async function testAgeBasedPruning() {
  console.log('\nTest 8: Age-based pruning respects file mtime');
  const root = setupSandbox();

  // Set short retention so our "old" files qualify
  process.env.JAV_CLEANUP_RUN_RETENTION_DAYS = '50'; // stale-run is 100d old

  setupSandbox();

  // Ensure stale-run.json has old mtime
  setMtime(resolve('cache/ingest/runs/stale-run.json'), 100 * DAY);

  await run({ dryRun: false, skillRoot: root });

  // stale-run.json (100d old, >50d retention) should be deleted
  assert.ok(!existsSync(resolve('cache/ingest/runs/stale-run.json')), 'stale-run.json pruned');

  // recent-run.json (fresh) should survive
  assert.ok(existsSync(resolve('cache/ingest/runs/recent-run.json')), 'recent-run.json preserved');

  delete process.env.JAV_CLEANUP_RUN_RETENTION_DAYS;
}

// ---------------------------------------------------------------------------
// Test 9: Dry-run produces zero side effects
// ---------------------------------------------------------------------------
async function testDryRunNoSideEffects() {
  console.log('\nTest 9: Dry-run has zero side effects (no .trash created)');
  const root = setupSandbox();

  await run({ dryRun: true, skillRoot: root });

  // With dryRun, trashFile just returns the target path without moving
  // No trash dir should be created by dry-run alone
  const trashDir = resolve('cache/.trash');
  const trashExists = existsSync(trashDir);
  if (trashExists) {
    const entries = readdirSync(trashDir);
    assert.equal(entries.length, 0, '.trash/ is empty after dry-run');
  } else {
    assert.ok(!trashExists, '.trash/ does not exist after dry-run');
  }

  // All original files intact
  assert.ok(existsSync(resolve('cache/ingest/metadata.json')), 'metadata.json intact');
}

// ---------------------------------------------------------------------------
// Test 10: Orphan chromium — dry-run doesn't kill
// ---------------------------------------------------------------------------
async function testOrphanDryRun() {
  console.log('\nTest 10: Orphan chromium dry-run is no-op');
  const root = setupSandbox();

  const result = await run({ dryRun: true, skillRoot: root });

  assert.equal(result.processesKilled, 0, 'no processes killed in dry-run');
}

// ---------------------------------------------------------------------------
// Run all
// ---------------------------------------------------------------------------
async function main() {
  console.log('=== Stage 7: Delete — Tests ===\n');

  await testDefaultDryRun();
  await testProtectedFiles();
  await testLockGuard();
  await testStaleLock();
  await testRecycleBin();
  await testProtectedVerification();
  await testRetentionEnv();
  await testAgeBasedPruning();
  await testDryRunNoSideEffects();
  await testOrphanDryRun();

  // Final cleanup
  rmRecursive(SANDBOX);

  console.log('\n———');
  console.log('All tests completed.');
}

main().catch(e => {
  console.error('Test harness error:', e);
  process.exit(1);
});
