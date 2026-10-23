import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chunkLongReport,
  sendLongReport,
  summarizeTelegramReceipts,
} from '../stages/06-notify.mjs';

test('Telegram report chunking is deterministic and non-empty', () => {
  const text = `${'A'.repeat(2500)}\n\n${'B'.repeat(2500)}`;
  const chunks = chunkLongReport(text);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every(chunk => chunk.length > 0 && chunk.length <= 3800));
  assert.equal(chunks.join('\n\n'), text);
});

test('Telegram delivery summary requires valid message receipts', () => {
  const first = summarizeTelegramReceipts([{ message_id: 101 }, { message_id: 102 }]);
  const second = summarizeTelegramReceipts([{ message_id: 101 }, { message_id: 102 }]);
  assert.deepEqual(first, second);
  assert.deepEqual(
    { sent: first.sent, planned: first.plannedChunks, delivered: first.deliveredChunks },
    { sent: true, planned: 2, delivered: 2 },
  );
  assert.match(first.receiptSha256, /^[0-9a-f]{64}$/);
  assert.throws(() => summarizeTelegramReceipts([]), /no receipts/);
  assert.throws(() => summarizeTelegramReceipts([{ ok: true }]), /invalid receipt/);
});

test('Telegram chunk failure propagates and cannot produce a false sent receipt', async () => {
  let calls = 0;
  const bot = {
    telegram: {
      async sendMessage() {
        calls += 1;
        if (calls === 2) throw new Error('synthetic transport failure');
        return { message_id: 201 };
      },
    },
  };
  const text = `${'A'.repeat(2500)}\n\n${'B'.repeat(2500)}`;
  await assert.rejects(sendLongReport(bot, '123', text), /chunk 2\/2 delivery failed/);
  assert.equal(calls, 2);
});
