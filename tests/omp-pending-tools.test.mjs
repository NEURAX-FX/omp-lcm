import assert from 'node:assert/strict';
import test from 'node:test';
import { toConversationMessages } from '../dist/omp/adapter-messages.js';
import { createPendingToolCalls } from '../dist/omp/pending-tools.js';

function assistantWithCalls(...calls) {
  return {
    role: 'assistant',
    content: calls.map((id) => ({ type: 'toolCall', id, name: 'read', arguments: { path: id } })),
    api: 'anthropic',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1 },
    stopReason: 'toolUse',
    timestamp: 1000,
  };
}

test('record captures each pending tool part with its original ids', () => {
  const pending = createPendingToolCalls();
  const conv = toConversationMessages('s1', [assistantWithCalls('c1', 'c2')]);
  pending.record(conv);

  assert.equal(pending.size(), 2);
  const one = pending.take('c1');
  assert.equal(one.callID, 'c1');
  assert.equal(one.tool, 'read');
  assert.equal(one.messageID, conv[0].info.id);
  assert.equal(one.partID, conv[0].parts[0].id);
  assert.deepEqual(one.input, { path: 'c1' });
});

test('take removes the record so a duplicate result finds nothing', () => {
  const pending = createPendingToolCalls();
  pending.record(toConversationMessages('s1', [assistantWithCalls('c1')]));

  assert.ok(pending.take('c1'));
  assert.equal(pending.take('c1'), undefined);
  assert.equal(pending.size(), 0);
});

test('take returns undefined for an unknown call id', () => {
  const pending = createPendingToolCalls();
  assert.equal(pending.take('nope'), undefined);
});

test('non-tool parts and settled tool parts are not recorded', () => {
  const pending = createPendingToolCalls();
  pending.record(toConversationMessages('s1', [{ role: 'user', content: 'hi', timestamp: 1 }]));
  assert.equal(pending.size(), 0);

  const conv = toConversationMessages('s1', [assistantWithCalls('c9')]);
  conv[0].parts[0].state = { status: 'completed', input: {}, output: 'done' };
  pending.record(conv);
  assert.equal(pending.size(), 0, 'an already-settled call has nothing to wait for');
});

test('the registry is bounded and drops the oldest entries', () => {
  const pending = createPendingToolCalls(3);
  for (const id of ['a', 'b', 'c', 'd']) {
    pending.record(toConversationMessages('s1', [assistantWithCalls(id)]));
  }

  assert.equal(pending.size(), 3);
  assert.equal(pending.take('a'), undefined, 'oldest was evicted');
  for (const id of ['b', 'c', 'd']) assert.ok(pending.take(id), `${id} retained`);
});

test('clear drops every record', () => {
  const pending = createPendingToolCalls();
  pending.record(toConversationMessages('s1', [assistantWithCalls('c1', 'c2')]));
  pending.clear();
  assert.equal(pending.size(), 0);
});
