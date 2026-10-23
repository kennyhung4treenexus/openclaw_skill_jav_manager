import assert from 'node:assert/strict';
import test from 'node:test';
import { diffSnapshots, preferMissavWs } from '../stages/06-notify.mjs';

test('preferMissavWs rewrites the old host and keeps the path', () => {
  assert.equal(
    preferMissavWs('https://missav.ai/SNOS-436'),
    'https://missav.ws/SNOS-436',
  );
  assert.equal(
    preferMissavWs('https://www.missav.ai/FNS-263-uncensored-leak/'),
    'https://missav.ws/FNS-263-uncensored-leak/',
  );
  assert.equal(
    preferMissavWs('https://missav.ws/JUR-883-chinese-subtitle/'),
    'https://missav.ws/JUR-883-chinese-subtitle/',
  );
  assert.equal(preferMissavWs('https://javdb.com/v/abc'), 'https://javdb.com/v/abc');
});

test('ranking and new-video style telegram links no longer use missav.ai', () => {
  const lines = diffSnapshots(
    [],
    [{
      code: 'SNOS-436',
      url: 'https://missav.ai/SNOS-436',
      maker: 'S1',
      actress: 'A',
      title: 'T',
    }],
    '每日',
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], /href="https:\/\/missav\.ws\/SNOS-436"/);
  assert.doesNotMatch(lines[0], /missav\.ai/);
});
