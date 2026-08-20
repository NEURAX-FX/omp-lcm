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
