/**
 * Tests for Stage 6: Notify — diffSnapshots (pure function)
 *
 * Focus: diffSnapshots should emit only new entries (🆕), never removed entries (❌).
 * This is a pure function test — no mocks for Notion, Telegram, or filesystem needed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Import target
// ---------------------------------------------------------------------------
const MODULE_PATH = '../stages/06-notify.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function item(code, maker = 'MFR', actress = '杉崎理沙', title = `Title ${code}`) {
  return { code, maker, actress, title };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('diffSnapshots — no removed-entry lines', () => {
  it('should emit 🆕 for new entries', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('ABC-001')];
    const curr = [item('ABC-001'), item('ABC-002')];

    const lines = diffSnapshots(prev, curr, '日冠');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('ABC-002'));
    assert.ok(lines[0].includes('🆕日冠'));
  });

  it('should NOT emit ❌ lines for removed entries', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('ABC-001'), item('ABC-002')];
    const curr = [item('ABC-001')];  // ABC-002 removed

    const lines = diffSnapshots(prev, curr, '日冠');
    assert.equal(lines.length, 0);  // no ❌ lines
  });

  it('should return empty when prev and curr match exactly', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const items = [item('A-001'), item('A-002')];
    const lines = diffSnapshots(items, items, '日冠');
    assert.equal(lines.length, 0);
  });

  it('should return empty when both are empty', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const lines = diffSnapshots([], [], '三冠王');
    assert.equal(lines.length, 0);
  });

  it('should handle multiple new entries at once', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('A-001')];
    const curr = [item('A-001'), item('B-001'), item('C-001'), item('D-001')];

    const lines = diffSnapshots(prev, curr, '週冠');
    assert.equal(lines.length, 3);
    for (const line of lines) {
      assert.ok(line.includes('🆕週冠'));
    }
  });

  it('should work with all ranking label types', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('A-001')];
    const curr = [item('A-001'), item('B-001')];

    for (const label of ['日冠', '週冠', '月冠', '三冠王']) {
      const lines = diffSnapshots(prev, curr, label);
      assert.equal(lines.length, 1);
      assert.ok(lines[0].includes(`🆕${label}`));
    }
  });

  it('should format output as HTML code link with maker, actress, title, and 🆕label', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [];
    const curr = [item('XYZ-999', 'MFR-Corp', '松本英美', 'Hello World')];

    const lines = diffSnapshots(prev, curr, '月冠');
    assert.equal(lines.length, 1);
    assert.equal(lines[0], '<a href="https://javdb.com/v/XYZ-999">XYZ-999</a> | MFR-Corp | 松本英美 | Hello World  🆕月冠');
  });
});

describe('diffSnapshots — edge cases', () => {
  it('should treat different codes as different items (case-sensitive)', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('abc-001')];
    const curr = [item('abc-001'), item('ABC-001')];  // different case

    const lines = diffSnapshots(prev, curr, '日冠');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('ABC-001'));
  });

  it('should ignore entries with empty code', async () => {
    const { diffSnapshots } = await import(MODULE_PATH);

    const prev = [item('')];
    const curr = [item(''), item('CODE-001')];

    const lines = diffSnapshots(prev, curr, '日冠');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes('CODE-001'));
  });
});
