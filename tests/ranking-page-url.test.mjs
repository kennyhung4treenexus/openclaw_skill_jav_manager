import assert from 'node:assert/strict';
import test from 'node:test';
import { rankingPageUrl } from '../stages/04-rankings.mjs';

test('page 1 keeps sort query intact', () => {
  const base = 'https://missav.ws/dm301/today-hot?sort=released_at';
  assert.equal(rankingPageUrl(base, 1), base);
});

test('later pages append page without a second question mark', () => {
  const url = rankingPageUrl('https://missav.ws/dm170/weekly-hot?sort=released_at', 3);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('sort'), 'released_at');
  assert.equal(parsed.searchParams.get('page'), '3');
  assert.equal((url.match(/\?/g) || []).length, 1);
});
