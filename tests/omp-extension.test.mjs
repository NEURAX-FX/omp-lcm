import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../dist/omp/extension.js';

function makeStore(overrides = {}) {
  const calls = { captured: [], transformed: 0, closed: 0 };
  return {
    calls,
    async init() {},
    async close() {
      calls.closed += 1;
    },
    async captureDeferred(event) {
      calls.captured.push(event);
    },
    async transformMessages() {
      calls.transformed += 1;
      return false;
    },
    async buildCompactionContext() {
      return undefined;
    },
    systemHint() {
      return undefined;
    },
    ...overrides,
  };
}

function makeCtx(sessionID = 's1', header = {}) {
  return {
    cwd: '/work',
    sessionManager: {
      getSessionId: () => sessionID,
      getHeader: () => ({ title: 'T', ...header }),
    },
  };
}

const quiet = { warn() {} };

test('session_start initializes the store and captures session.created', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  assert.equal(store.calls.captured[0].type, 'session.created');
  assert.equal(store.calls.captured[0].properties.info.id, 's1');
  assert.equal(store.calls.captured[0].properties.info.directory, '/work');
});

test('session_start resolves parentSession from the header', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(
    makeCtx('s2', {
      parentSession: '/root/.omp/agent/sessions/-w/2026-08-19T00-00-00-000Z_parent99.jsonl',
    }),
  );
  assert.equal(store.calls.captured[0].properties.info.parentID, 'parent99');
});

test('message_end archives one message.updated plus its parts', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'hi', timestamp: 1 });
  assert.deepEqual(
    store.calls.captured.map((e) => e.type),
    ['message.updated', 'message.part.updated'],
  );
});

test('context returns undefined when the store made no change', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  const messages = [{ role: 'user', content: 'q', timestamp: 1 }];
  assert.equal(await runtime.onContext(makeCtx(), messages), undefined);
  assert.equal(store.calls.transformed, 1);
});

test('context returns replaced messages when the store injected recall', async () => {
  const store = makeStore({
    async transformMessages(conv) {
      conv[0].parts.push({
        id: 'synthetic',
        messageID: conv[0].info.id,
        sessionID: conv[0].info.sessionID,
        type: 'text',
        text: '[recalled] db.ts',
      });
      return true;
    },
  });
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());

  const messages = [{ role: 'user', content: 'q', timestamp: 1 }];
  const result = await runtime.onContext(makeCtx(), messages);
  assert.ok(result);
  const texts = result.messages[0].content.map((b) => b.text);
  assert.ok(texts.some((t) => t.includes('[recalled] db.ts')));
});

test('context prepends the system hint as a developer message', async () => {
  const store = makeStore({
    systemHint: () => 'Archived state may exist.',
    async transformMessages() {
      return true;
    },
  });
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());

  const result = await runtime.onContext(makeCtx(), [{ role: 'user', content: 'q', timestamp: 1 }]);
  assert.equal(result.messages[0].role, 'developer');
  assert.equal(result.messages[0].content, 'Archived state may exist.');
  assert.equal(typeof result.messages[0].timestamp, 'number');
});

test('session.compacting returns the resume note as context', async () => {
  const store = makeStore({
    async buildCompactionContext() {
      return 'LCM resume note body';
    },
  });
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  assert.deepEqual(await runtime.onCompacting(makeCtx(), 's1'), {
    context: ['LCM resume note body'],
  });
});

test('session.compacting returns undefined when there is no note', async () => {
  const runtime = createRuntime({ store: makeStore(), logger: quiet });
  await runtime.onSessionStart(makeCtx());
  assert.equal(await runtime.onCompacting(makeCtx(), 's1'), undefined);
});

test('a throwing store never propagates out of a handler', async () => {
  const warnings = [];
  const store = makeStore({
    async captureDeferred() {
      throw new Error('disk on fire');
    },
    async transformMessages() {
      throw new Error('disk on fire');
    },
  });
  const runtime = createRuntime({ store, logger: { warn: (m) => warnings.push(m) } });

  await runtime.onSessionStart(makeCtx());
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(
    await runtime.onContext(makeCtx(), [{ role: 'user', content: 'x', timestamp: 1 }]),
    undefined,
  );
  assert.ok(warnings.length >= 2, 'failures are logged, not thrown');
});

test('handlers before session_start are inert', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(store.calls.captured.length, 0);
});

test('shutdown closes the store once', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  await runtime.onShutdown();
  await runtime.onShutdown();
  assert.equal(store.calls.closed, 1);
});

test('a failed init degrades to no-op instead of throwing', async () => {
  const store = makeStore({
    async init() {
      throw new Error('schema too new');
    },
  });
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  assert.equal(runtime.isDegraded(), true);
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(store.calls.captured.length, 0);
});

test('session updates capture updated and compacted events', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onSessionUpdate(makeCtx(), 'updated');
  await runtime.onSessionUpdate(makeCtx(), 'compacted');
  assert.deepEqual(
    store.calls.captured.map((e) => e.type),
    ['session.updated', 'session.compacted'],
  );
});

const assistantWithCall = (callId, timestamp) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id: callId, name: 'read', arguments: { path: 'a.ts' } }],
  api: 'anthropic',
  provider: 'anthropic',
  model: 'claude',
  usage: { input: 1, output: 1 },
  stopReason: 'toolUse',
  timestamp,
});

const toolResultFor = (callId, text, timestamp, isError = false) => ({
  role: 'toolResult',
  toolCallId: callId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError,
  timestamp,
});

/** Parts written by the archive path, keyed by the part id they targeted. */
function archivedParts(store) {
  const byId = new Map();
  for (const event of store.calls.captured) {
    if (event.type !== 'message.part.updated') continue;
    byId.set(event.properties.part.id, event.properties.part);
  }
  return byId;
}

test('a toolResult settles the tool part archived for its call', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), assistantWithCall('call_x', 1000));
  const toolPartId = [...archivedParts(store).values()].find((p) => p.type === 'tool')?.id;
  assert.ok(toolPartId, 'the assistant turn archived a tool part');

  await runtime.onMessageEnd(makeCtx(), toolResultFor('call_x', 'FILE_BODY', 1010));

  const settled = archivedParts(store).get(toolPartId);
  assert.equal(settled.type, 'tool', 'the result updates the original tool part');
  assert.equal(settled.state.status, 'completed');
  assert.equal(settled.state.output, 'FILE_BODY');
  assert.deepEqual(settled.state.input, { path: 'a.ts' });

  const messageTypes = store.calls.captured
    .filter((e) => e.type === 'message.updated')
    .map((e) => e.properties.info.role);
  assert.deepEqual(messageTypes, ['assistant'], 'no synthetic toolResult message is archived');
});

test('an errored toolResult settles the tool part as an error', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), assistantWithCall('call_e', 1000));
  const toolPartId = [...archivedParts(store).values()].find((p) => p.type === 'tool')?.id;
  await runtime.onMessageEnd(makeCtx(), toolResultFor('call_e', 'boom', 1010, true));

  const settled = archivedParts(store).get(toolPartId);
  assert.equal(settled.state.status, 'error');
  assert.equal(settled.state.error, 'boom');
});

test('a toolResult with no known call archives as its own message', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), toolResultFor('orphan', 'stray output', 1010));

  const roles = store.calls.captured
    .filter((e) => e.type === 'message.updated')
    .map((e) => e.properties.info.role);
  assert.deepEqual(roles, ['toolResult'], 'output is archived rather than dropped');
});

test('interleaved calls settle against their own parts', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: quiet });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), {
    role: 'assistant',
    content: [
      { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'one.ts' } },
      { type: 'toolCall', id: 'c2', name: 'read', arguments: { path: 'two.ts' } },
    ],
    api: 'anthropic',
    provider: 'anthropic',
    model: 'claude',
    usage: { input: 1, output: 1 },
    stopReason: 'toolUse',
    timestamp: 1000,
  });

  // Results arrive out of order, as concurrent tools do.
  await runtime.onMessageEnd(makeCtx(), toolResultFor('c2', 'TWO', 1020));
  await runtime.onMessageEnd(makeCtx(), toolResultFor('c1', 'ONE', 1030));

  const tools = [...archivedParts(store).values()].filter((p) => p.type === 'tool');
  assert.equal(tools.length, 2);
  const byCall = new Map(tools.map((p) => [p.callID, p]));
  assert.equal(byCall.get('c1').state.output, 'ONE');
  assert.equal(byCall.get('c2').state.output, 'TWO');
  assert.deepEqual(byCall.get('c1').state.input, { path: 'one.ts' });
  assert.deepEqual(byCall.get('c2').state.input, { path: 'two.ts' });
});
