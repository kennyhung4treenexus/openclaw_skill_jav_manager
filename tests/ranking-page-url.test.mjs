import assert from 'node:assert/strict';
import test from 'node:test';
import { RANKING_ENDPOINTS, RANKING_WARMUP_URL, rankingPageUrl } from '../stages/04-rankings.mjs';

const DAILY = 'https://jable.tv/hot/?mode=async&function=get_block&block_id=list_videos_common_videos_list&sort_by=video_viewed_today';
const WEEKLY = 'https://jable.tv/hot/?mode=async&function=get_block&block_id=list_videos_common_videos_list&sort_by=video_viewed_week';
const MONTHLY = 'https://jable.tv/hot/?mode=async&function=get_block&block_id=list_videos_common_videos_list&sort_by=video_viewed_month';

test('exports the three Jable ranking endpoint URLs', () => {
  const byKey = Object.fromEntries(RANKING_ENDPOINTS.map(({ key, url }) => [key, url]));
  assert.deepEqual(Object.keys(byKey), ['Daily Star', 'Weekly Star', 'Monthly Star']);
  assert.equal(byKey['Daily Star'], DAILY);
  assert.equal(byKey['Weekly Star'], WEEKLY);
  assert.equal(byKey['Monthly Star'], MONTHLY);
});

test('rankings warmup is the Jable hot page', () => {
  assert.equal(RANKING_WARMUP_URL, 'https://jable.tv/hot/');
});

test('page 1 returns the base string unchanged', () => {
  assert.equal(rankingPageUrl(DAILY, 1), DAILY);
  const parsed = new URL(rankingPageUrl(DAILY, 1));
  assert.equal(parsed.searchParams.has('from'), false);
  assert.equal(parsed.searchParams.has('page'), false);
});

test('daily pages 2 through 5 set from=02 through from=05', () => {
  for (const page of [2, 3, 4, 5]) {
    const url = rankingPageUrl(DAILY, page);
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get('from'), String(page).padStart(2, '0'));
    assert.equal(parsed.searchParams.has('page'), false);
    assert.equal(parsed.searchParams.get('mode'), 'async');
    assert.equal(parsed.searchParams.get('function'), 'get_block');
    assert.equal(parsed.searchParams.get('block_id'), 'list_videos_common_videos_list');
    assert.equal(parsed.searchParams.get('sort_by'), 'video_viewed_today');
    assert.equal((url.match(/\?/g) || []).length, 1);
  }
});

test('page 5 preserves sort_by=video_viewed_month', () => {
  const parsed = new URL(rankingPageUrl(MONTHLY, 5));
  assert.equal(parsed.searchParams.get('sort_by'), 'video_viewed_month');
  assert.equal(parsed.searchParams.get('from'), '05');
  assert.equal(parsed.searchParams.get('mode'), 'async');
  assert.equal(parsed.searchParams.get('function'), 'get_block');
  assert.equal(parsed.searchParams.get('block_id'), 'list_videos_common_videos_list');
  assert.equal(parsed.searchParams.has('page'), false);
});

test('later pages remove a stray page parameter', () => {
  const base = `${WEEKLY}&page=3`;
  const parsed = new URL(rankingPageUrl(base, 4));
  assert.equal(parsed.searchParams.has('page'), false);
  assert.equal(parsed.searchParams.get('from'), '04');
  assert.equal(parsed.searchParams.get('sort_by'), 'video_viewed_week');
  assert.equal(parsed.searchParams.get('mode'), 'async');
  assert.equal(parsed.searchParams.get('function'), 'get_block');
  assert.equal(parsed.searchParams.get('block_id'), 'list_videos_common_videos_list');
});
