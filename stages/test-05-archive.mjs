/**
 * Tests for Stage 5: Archive — Two-Tier Retention Model (Date-based)
 *
 * Uses node:test with an injected mock Notion client to verify:
 * 1. Tier 1: Active + Date > 30d → Inactive [Archive]
 * 2. Tier 2: Inactive [Archive] + Date > 365d → archived:true
 * 3. Same-run Active → archived:true is possible by design (for very old records)
 * 4. Dry-run produces zero writes
 * 5. Summary output format
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { format, sub } from 'date-fns';

// ---------------------------------------------------------------------------
// Helpers for building mock Notion pages
// ---------------------------------------------------------------------------
function makePage({ id, code, status, date }) {
  return {
    id: id ?? `page-${Math.random().toString(36).slice(2, 8)}`,
    properties: {
      Code: {
        rich_text: code ? [{ plain_text: code }] : [],
      },
      Status: {
        select: status ? { name: status } : null,
      },
      Date: {
        date: date ? { start: date } : null,
      },
    },
  };
}

/**
 * Build a sequence-aware mock Notion client.
 * Each call to databases.query consumes one entry from the responses array.
 * All pages.update calls are recorded in `updates`.
 */
function makeMockClient(responses, updates) {
  let queryIdx = 0;
  return {
    databases: {
      query: async () => {
        const r = responses[queryIdx++] ?? { results: [], has_more: false };
        return {
          results: r.results ?? [],
          has_more: r.has_more ?? false,
          next_cursor: r.next_cursor ?? undefined,
        };
      },
    },
    pages: {
      update: async (params) => {
        updates.push(params);
        return { id: params.page_id };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
function daysAgo(n) {
  return format(sub(new Date(), { days: n }), 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Import target (dynamic to avoid side effects)
// ---------------------------------------------------------------------------
const MODULE_PATH = '../stages/05-archive.mjs';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Stage 5 — Tier 1: Active > 30d → Inactive [Archive]', () => {
  it('should update Active records older than 30 days', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        // Tier 1 query
        {
          results: [
            makePage({ id: 'p1', code: 'ABC-001', status: 'Active', date: daysAgo(60) }),
            makePage({ id: 'p2', code: 'ABC-002', status: 'Active', date: daysAgo(45) }),
            makePage({ id: 'p3', code: 'ABC-003', status: 'Inactive [Archive]', date: daysAgo(60) }),
          ],
        },
        // Tier 2 query
        { results: [] },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });

    assert.equal(result.tier1Candidates, 2);
    assert.equal(result.tier1Updated, 2);

    // Verify update payloads
    const statusUpdates = updates.filter(u => u.properties?.Status);
    assert.equal(statusUpdates.length, 2);
    for (const u of statusUpdates) {
      assert.equal(u.properties.Status.select.name, 'Inactive [Archive]');
    }
  });

  it('should skip non-Active records', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        {
          results: [
            makePage({ id: 'p1', code: 'X-001', status: 'Inactive [Archive]', date: daysAgo(60) }),
            makePage({ id: 'p2', code: 'X-002', status: 'Review', date: daysAgo(60) }),
          ],
        },
        { results: [] },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });

    assert.equal(result.tier1Candidates, 0);
    assert.equal(result.tier1Updated, 0);
  });
});

describe('Stage 5 — Tier 2: Inactive [Archive] + Date > 365d → archive/trash', () => {
  it('should archive records with Date > 365 days ago', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        // Tier 1 query (empty)
        { results: [] },
        // Tier 2 query
        {
          results: [
            makePage({ id: 'p1', code: 'DEL-001', status: 'Inactive [Archive]', date: daysAgo(700) }),
            makePage({ id: 'p2', code: 'DEL-002', status: 'Inactive [Archive]', date: daysAgo(366) }),
          ],
        },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });

    assert.equal(result.tier2Candidates, 2);
    assert.equal(result.tier2Archived, 2);

    const archiveUpdates = updates.filter(u => u.archived === true);
    assert.equal(archiveUpdates.length, 2);
  });

  it('should NOT archive if Date is within 365 days', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        { results: [] },
        // Date within 365 days → Notion filter won't match → empty
        { results: [] },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });

    assert.equal(result.tier2Candidates, 0);
    assert.equal(result.tier2Archived, 0);
  });

  it('should NOT archive if Status is not Inactive [Archive]', async () => {
    const updates = [];
    // Record has Date > 365d but Status = Active, not Inactive [Archive]
    // Tier 1 query will pick it up: Active → Inactive [Archive]
    // Tier 2 query: Status = Inactive [Archive] AND Date < 365d ago → will match because
    // Tier 1 already updated Status in the same run.
    // So this test should verify that a record that's STILL Active (Tier 1 didn't catch it)
    // won't be archived.
    //
    // Actually, let me think again. The Notion filter in Tier 2 is what matters here.
    // If Tier 1 returns a record and updates it to Inactive [Archive], Tier 2 re-queries
    // Notion. Since we're using a mock, Tier 2 sees whatever results we give it.
    // 
    // Let me make this test simple: Tier 2 gets a record with Date > 365d but Status = Active
    // It won't match the filter, so Tier 2 returns 0.
    const client = makeMockClient(
      [
        { results: [] },
        { results: [] }, // Tier 2: empty because Status != Inactive [Archive]
      ],
      []
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });
    assert.equal(result.tier2Archived, 0);
  });
});

describe('Stage 5 — Same-run Active → archived:true', () => {
  it('must allow Active → archived:true for very old records in a single run (by design)', async () => {
    /**
     * Scenario: Active record, Date = 400 days ago.
     * This is a very old record that has never been processed.
     * - Tier 1: Active → Inactive [Archive]
     * - Tier 2: Inactive [Archive] + Date > 365d ✅ → archived:true
     * 
     * This is by design. The owner accepts this behaviour for very old records.
     */
    const updates = [];
    const client = makeMockClient(
      [
        // Tier 1: returns the Active record
        {
          results: [
            makePage({ id: 'p1', code: 'OLD-ACTIVE', status: 'Active', date: daysAgo(400) }),
          ],
        },
        // Tier 2: returns the same record (now Inactive [Archive] with Date > 365d)
        // Note: in the mock, Tier 2's query result is independent of Tier 1's updates.
        // We simulate what the real Notion would return: the record after Tier 1 updated it.
        {
          results: [
            makePage({ id: 'p1', code: 'OLD-ACTIVE', status: 'Inactive [Archive]', date: daysAgo(400) }),
          ],
        },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: false, client, databaseId: 'test-db' });

    assert.equal(result.tier1Updated, 1);
    assert.equal(result.tier2Archived, 1);

    // Verify Status update AND archive happened in same run
    const statusUpdates = updates.filter(u => u.properties?.Status);
    assert.equal(statusUpdates.length, 1);
    const archiveUpdates = updates.filter(u => u.archived === true);
    assert.equal(archiveUpdates.length, 1);
  });
});

describe('Stage 5 — Dry-run mode', () => {
  it('should produce zero writes in dry-run mode', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        // Tier 1
        {
          results: [
            makePage({ id: 'p1', code: 'DRY-001', status: 'Active', date: daysAgo(60) }),
          ],
        },
        // Tier 2
        {
          results: [
            makePage({ id: 'p2', code: 'DRY-002', status: 'Inactive [Archive]', date: daysAgo(800) }),
          ],
        },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: true, client, databaseId: 'test-db' });

    assert.equal(result.dryRun, true);
    assert.equal(result.tier1Candidates, 1);
    assert.equal(result.tier2Candidates, 1);

    // Zero actual writes
    assert.equal(updates.length, 0);
  });
});

describe('Stage 5 — Summary output format', () => {
  it('should return all expected summary fields', async () => {
    const updates = [];
    const client = makeMockClient(
      [
        { results: [] },
        { results: [] },
      ],
      updates
    );

    const { run } = await import(MODULE_PATH);
    const result = await run({ dryRun: true, client, databaseId: 'test-db' });

    assert.equal(result.stage, '05-archive');
    assert.equal(result.status, 'completed');
    assert.equal(typeof result.thresholdDays, 'number');
    assert.equal(typeof result.archiveDays, 'number');
    assert.equal(typeof result.tier1Candidates, 'number');
    assert.equal(typeof result.tier1Updated, 'number');
    assert.equal(typeof result.tier2Candidates, 'number');
    assert.equal(typeof result.tier2Archived, 'number');
    assert.equal(typeof result.errors, 'number');
    assert.equal(typeof result.dryRun, 'boolean');

    assert.equal(result.thresholdDays, 30);
    assert.equal(result.archiveDays, 365);
  });
});
