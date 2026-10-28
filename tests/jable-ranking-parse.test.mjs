import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { extractHotCodesFromHtml } from '../stages/04-rankings.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'jable');

function load(name) {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

const GRID_CODES = Array.from({ length: 11 }, (_, index) => {
  return `ABCD-${String(index + 1).padStart(3, '0')}`;
});

test('jable grid returns ABCD-001 through ABCD-011 and is not suspicious', () => {
  const result = extractHotCodesFromHtml(load('grid.html'), {});
  assert.deepEqual([...result.codes].sort(), GRID_CODES);
  assert.equal(result.itemCount, 11);
  assert.equal(result.suspicious, false);
  assert.equal(result.hasThumbnailGrid, true);
  assert.equal(result.hasPagination, true);
  assert.equal(result.codes.has('ZZZZ-999'), false);
  assert.equal(result.codes.has('SOMEONE'), false);
  assert.equal(result.reasons.some((reason) => /h1/i.test(reason)), false);
});

test('short jable grid is suspicious for a low code count', () => {
  const result = extractHotCodesFromHtml(load('short-grid.html'), {});
  assert.equal(result.itemCount, 3);
  assert.equal(result.suspicious, true);
  assert.match(result.reasons.join('\n'), /low code count/);
  assert.equal(result.hasPagination, true);
});

test('missav thumbnail markup yields no jable codes', () => {
  const result = extractHotCodesFromHtml(load('missav-thumbnail.html'), {});
  assert.equal(result.itemCount, 0);
  assert.equal(result.codes.size, 0);
  assert.equal(result.suspicious, true);
  assert.equal(result.hasThumbnailGrid, false);
  assert.match(result.reasons.join('\n'), /no video grid/);
  assert.match(result.reasons.join('\n'), /zero codes extracted/);
});
