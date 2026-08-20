import assert from 'node:assert/strict';
import test from 'node:test';
import { messageEvents, parseParentSession, sessionEvent } from '../dist/omp/adapter-events.js';

test('parseParentSession accepts a bare session id', () => {
  assert.equal(
    parseParentSession('01a01ac1-18a2-7000-a7bc-3ca092a6a14e'),
    '01a01ac1-18a2-7000-a7bc-3ca092a6a14e',
  );
});

test('parseParentSession extracts the id from a session file path', () => {
  const p =
    '/root/.omp/agent/sessions/-work/2026-08-19T16-00-57-506Z_01a01ac1-18a2-7000-a7bc-3ca092a6a14e.jsonl';
  assert.equal(parseParentSession(p), '01a01ac1-18a2-7000-a7bc-3ca092a6a14e');
});

test('parseParentSession returns undefined for unusable input', () => {
  assert.equal(parseParentSession(undefined), undefined);
  assert.equal(parseParentSession(''), undefined);
  assert.equal(parseParentSession('   '), undefined);
});

test('sessionEvent emits the opencode event shape the store dispatches on', () => {
  const event = sessionEvent('created', {
    sessionID: 's1',
    title: 'my session',
    directory: '/work',
    parentSessionID: 'root1',
  });
  assert.equal(event.type, 'session.created');
  assert.equal(event.properties.info.id, 's1');
  assert.equal(event.properties.info.sessionID, 's1');
  assert.equal(event.properties.info.title, 'my session');
  assert.equal(event.properties.info.directory, '/work');
  assert.equal(event.properties.info.parentID, 'root1');
  assert.equal(typeof event.properties.info.time.created, 'number');
});

test('sessionEvent maps every supported kind', () => {
  for (const [kind, expected] of [
    ['created', 'session.created'],
    ['updated', 'session.updated'],
    ['deleted', 'session.deleted'],
    ['compacted', 'session.compacted'],
  ]) {
    assert.equal(sessionEvent(kind, { sessionID: 's1' }).type, expected);
  }
});

test('session.compacted carries the sessionID the store reads', () => {
  const event = sessionEvent('compacted', { sessionID: 's9' });
  assert.equal(event.properties.sessionID, 's9');
});

test('messageEvents emits one message.updated plus one part event per part', () => {
  const events = messageEvents('s1', [{ role: 'user', content: 'hello', timestamp: 1000 }]);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'message.updated');
  assert.equal(events[0].properties.info.sessionID, 's1');
  assert.equal(events[1].type, 'message.part.updated');
  assert.equal(events[1].properties.part.messageID, events[0].properties.info.id);
  assert.equal(events[1].properties.part.type, 'text');
});

test('messageEvents orders message.updated before its parts', () => {
  const events = messageEvents('s1', [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
      ],
      timestamp: 2000,
    },
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['message.updated', 'message.part.updated', 'message.part.updated'],
  );
});

test('messageEvents skips unmappable messages without throwing', () => {
  assert.deepEqual(messageEvents('s1', [null, undefined, { content: 'no role' }]), []);
});
