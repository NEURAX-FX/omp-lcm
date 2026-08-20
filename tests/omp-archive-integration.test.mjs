import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createRuntime } from '../dist/omp/extension.js';
import { SqliteLcmStore } from '../dist/store.js';
import { cleanupWorkspace, makeOptions, makeWorkspace } from './helpers.mjs';

function makeCtx(workspace, sessionID = 'sessInt') {
  return {
    cwd: workspace,
    sessionManager: {
      getSessionId: () => sessionID,
      getHeader: () => ({ title: 'integration' }),
    },
  };
}

const toolCall = (id, name, args, timestamp) => ({
  role: 'assistant',
  content: [{ type: 'toolCall', id, name, arguments: args }],
  api: 'anthropic',
  provider: 'anthropic',
  model: 'claude',
  usage: { input: 1, output: 1 },
  stopReason: 'toolUse',
  timestamp,
});

const toolResult = (id, name, text, timestamp) => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text }],
  isError: false,
  timestamp,
});

/** Read archived parts straight from SQLite, bypassing every in-memory cache. */
function readParts(workspace) {
  const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT part_json FROM parts')
      .all()
      .map((row) => JSON.parse(row.part_json));
  } finally {
    db.close();
  }
}

function readMessageRoles(workspace) {
  const db = new DatabaseSync(path.join(workspace, '.lcm', 'lcm.db'), { readOnly: true });
  try {
    return db
      .prepare('SELECT info_json FROM messages')
      .all()
      .map((row) => JSON.parse(row.info_json).role);
  } finally {
    db.close();
  }
}

test('a tool result delivered in its own message settles the archived tool part', async () => {
  const workspace = makeWorkspace('omp-archive-tool-merge');
  let store;

  try {
    store = new SqliteLcmStore(workspace, makeOptions());
    const runtime = createRuntime({ store, logger: { warn() {} } });
    const ctx = makeCtx(workspace);

    await runtime.onSessionStart(ctx);
    await runtime.onMessageEnd(ctx, toolCall('call_1', 'read', { path: 'a.ts' }, 1000));
    await runtime.onMessageEnd(ctx, toolResult('call_1', 'read', 'FILE_BODY', 1010));
    await runtime.onShutdown();
    store = undefined;

    const parts = readParts(workspace);
    const toolParts = parts.filter((part) => part.type === 'tool');
    assert.equal(toolParts.length, 1, 'the result updates the call part rather than adding one');
    assert.equal(toolParts[0].state.status, 'completed');
    assert.equal(toolParts[0].state.output, 'FILE_BODY');
    assert.deepEqual(toolParts[0].state.input, { path: 'a.ts' });

    assert.deepEqual(
      readMessageRoles(workspace),
      ['assistant'],
      'no synthetic toolResult message is archived',
    );
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('excludeToolPrefixes suppresses archived tool output', async () => {
  const workspace = makeWorkspace('omp-archive-tool-exclude');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ privacy: { excludeToolPrefixes: ['secretive_'] } }),
    );
    const runtime = createRuntime({ store, logger: { warn() {} } });
    const ctx = makeCtx(workspace);

    await runtime.onSessionStart(ctx);
    await runtime.onMessageEnd(ctx, toolCall('call_x', 'secretive_dump', { path: 'x' }, 1000));
    await runtime.onMessageEnd(
      ctx,
      toolResult('call_x', 'secretive_dump', 'TOP_SECRET_PAYLOAD', 1010),
    );
    await runtime.onShutdown();
    store = undefined;

    const archived = JSON.stringify(readParts(workspace));
    assert.ok(!archived.includes('TOP_SECRET_PAYLOAD'), 'excluded output must not be archived');
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('redactPatterns scrub secrets from archived tool output', async () => {
  const workspace = makeWorkspace('omp-archive-tool-redact');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ privacy: { redactPatterns: ['sk-[A-Za-z0-9]+'] } }),
    );
    const runtime = createRuntime({ store, logger: { warn() {} } });
    const ctx = makeCtx(workspace);

    await runtime.onSessionStart(ctx);
    await runtime.onMessageEnd(ctx, toolCall('call_r', 'read', { path: 'x' }, 1000));
    await runtime.onMessageEnd(ctx, toolResult('call_r', 'read', 'token sk-ABC123XYZ end', 1010));
    await runtime.onShutdown();
    store = undefined;

    const archived = JSON.stringify(readParts(workspace));
    assert.ok(!archived.includes('sk-ABC123XYZ'), 'the secret must not reach storage');
    assert.ok(archived.includes('REDACTED'), 'the redaction marker replaces it');
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});

test('archived turns are searchable and recalled into a later context', async () => {
  const workspace = makeWorkspace('omp-archive-recall');
  let store;

  try {
    store = new SqliteLcmStore(
      workspace,
      makeOptions({ minMessagesForTransform: 4, freshTailMessages: 2 }),
    );
    const runtime = createRuntime({ store, logger: { warn() {} } });
    const ctx = makeCtx(workspace, 'sessRecall');
    await runtime.onSessionStart(ctx);

    let clock = 1000;
    function nextTimestamp() {
      clock += 10;
      return clock;
    }

    const user = (text) => ({ role: 'user', content: text, timestamp: nextTimestamp() });
    const assistant = (text) => ({
      role: 'assistant',
      content: [{ type: 'text', text }],
      api: 'anthropic',
      provider: 'anthropic',
      model: 'claude',
      usage: { input: 1, output: 1 },
      stopReason: 'stop',
      timestamp: nextTimestamp(),
    });

    // Unrelated turns keep document frequency low for the term under test, so the
    // TF-IDF filter does not discard it as corpus-common.
    const history = [
      user('set up the CI pipeline with three parallel jobs'),
      assistant('CI pipeline configured.'),
      user('the deploy webhook secret is stored under ZX729ALBATROSS in vault'),
      assistant('Webhook secret recorded under ZX729ALBATROSS in vault.'),
      user('bump the postgres connection pool to 40'),
      assistant('Postgres pool bumped to 40.'),
    ];
    for (const message of history) await runtime.onMessageEnd(ctx, message);

    const hits = await store.grep({ query: 'ZX729ALBATROSS', sessionID: 'sessRecall' });
    assert.ok(hits.length > 0, 'archived turns are searchable');

    const incoming = [...history, user('what identifier was the webhook secret under?')];
    const snapshot = JSON.stringify(incoming);
    const result = await runtime.onContext(ctx, incoming);

    assert.ok(result, 'recall replaces the context for this turn');
    assert.equal(JSON.stringify(incoming), snapshot, 'the caller array is never mutated');

    const injected = result.messages
      .flatMap((message) =>
        typeof message.content === 'string'
          ? [message.content]
          : message.content.map((block) => block.text ?? ''),
      )
      .join('\n');
    assert.match(injected, /ZX729ALBATROSS/);

    const rewrittenAssistant = result.messages.find((message) => message.role === 'assistant');
    assert.equal(rewrittenAssistant.api, 'anthropic', 'provider fields survive the round trip');
    assert.equal(rewrittenAssistant.stopReason, 'stop');

    const note = await runtime.onCompacting(ctx, 'sessRecall');
    assert.ok(note?.context[0], 'compaction receives a resume note');

    await runtime.onShutdown();
    store = undefined;
  } finally {
    await store?.close();
    await cleanupWorkspace(workspace);
  }
});
