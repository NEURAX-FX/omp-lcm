import assert from 'node:assert/strict';
import test from 'node:test';
import { messageId, partId } from '../dist/omp/ids.js';

const msg = { role: 'user', content: 'hello', timestamp: 1000 };

test('messageId is deterministic across calls and object identities', () => {
  const a = messageId('s1', msg);
  const b = messageId('s1', { role: 'user', content: 'hello', timestamp: 1000 });
  assert.equal(a, b);
  assert.match(a, /^m_[0-9a-f]{16}$/);
});

test('messageId separates by session, role, timestamp, and content', () => {
  const base = messageId('s1', msg);
  assert.notEqual(base, messageId('s2', msg));
  assert.notEqual(base, messageId('s1', { ...msg, role: 'assistant' }));
  assert.notEqual(base, messageId('s1', { ...msg, timestamp: 1001 }));
  assert.notEqual(base, messageId('s1', { ...msg, content: 'hi' }));
});

test('messageId handles array content and is order-sensitive', () => {
  const one = messageId('s1', {
    role: 'assistant',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    timestamp: 5,
  });
  const two = messageId('s1', {
    role: 'assistant',
    content: [
      { type: 'text', text: 'b' },
      { type: 'text', text: 'a' },
    ],
    timestamp: 5,
  });
  assert.notEqual(one, two);
});

test('messageId does not collide on adjacent content boundaries', () => {
  const joined = messageId('s1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'ab' }],
    timestamp: 5,
  });
  const split = messageId('s1', {
    role: 'assistant',
    content: [
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ],
    timestamp: 5,
  });
  assert.notEqual(joined, split);
});

test('messageId tolerates a missing timestamp', () => {
  const id = messageId('s1', { role: 'user', content: 'x' });
  assert.match(id, /^m_[0-9a-f]{16}$/);
});

test('partId derives from messageID and index', () => {
  assert.equal(partId('m_abc', 0), 'm_abc_p0');
  assert.notEqual(partId('m_abc', 0), partId('m_abc', 1));
});
