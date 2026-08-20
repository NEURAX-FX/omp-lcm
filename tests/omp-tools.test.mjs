import assert from 'node:assert/strict';
import test from 'node:test';
import { LCM_TOOL_SPECS, registerLcmTools } from '../dist/omp/tools.js';

const EXPECTED = [
  'lcm_status',
  'lcm_retrieval_debug',
  'lcm_resume',
  'lcm_grep',
  'lcm_describe',
  'lcm_lineage',
  'lcm_pin_session',
  'lcm_unpin_session',
  'lcm_expand',
  'lcm_artifact',
  'lcm_blob_stats',
  'lcm_blob_gc',
  'lcm_compact',
  'lcm_doctor',
  'lcm_retention_report',
  'lcm_retention_prune',
  'lcm_export_snapshot',
  'lcm_import_snapshot',
];

function makePi() {
  const registered = [];
  const node = {};
  for (const method of ['optional', 'min', 'max', 'int', 'describe', 'default']) {
    node[method] = () => node;
  }
  return {
    registered,
    logger: { warn() {} },
    zod: {
      object: (shape) => ({ shape }),
      string: () => node,
      number: () => node,
      boolean: () => node,
    },
    registerTool(def) {
      registered.push(def);
    },
  };
}

const ctx = { cwd: '/work', sessionManager: { getSessionId: () => 's1' } };

function runtimeWith(store) {
  return { isDegraded: () => false, store: () => store };
}

test('all 18 tools are specified', () => {
  assert.deepEqual(
    LCM_TOOL_SPECS.map((s) => s.name),
    EXPECTED,
  );
});

test('registerLcmTools registers every spec with required omp fields', () => {
  const pi = makePi();
  registerLcmTools(pi, () => undefined);
  assert.equal(pi.registered.length, 18);
  for (const def of pi.registered) {
    assert.equal(typeof def.name, 'string');
    assert.ok(def.label, `${def.name} needs a label`);
    assert.ok(def.description, `${def.name} needs a description`);
    assert.ok(def.parameters, `${def.name} needs parameters`);
    assert.equal(typeof def.execute, 'function');
    assert.ok(['read', 'write'].includes(def.approval), `${def.name} approval tier`);
  }
});

test('a tool returns AgentToolResult content, not a bare string', async () => {
  const pi = makePi();
  registerLcmTools(pi, () =>
    runtimeWith({
      async resume() {
        return 'note body';
      },
    }),
  );

  const def = pi.registered.find((d) => d.name === 'lcm_resume');
  const result = await def.execute('call1', {}, undefined, undefined, ctx);
  assert.deepEqual(result.content, [{ type: 'text', text: 'note body' }]);
  assert.ok(!result.isError);
});

test('sessionID falls back to the active session', async () => {
  const pi = makePi();
  const seen = [];
  registerLcmTools(pi, () =>
    runtimeWith({
      async automaticRetrievalDebug(id) {
        seen.push(id);
        return 'debug';
      },
    }),
  );

  const def = pi.registered.find((d) => d.name === 'lcm_retrieval_debug');
  await def.execute('c', {}, undefined, undefined, ctx);
  assert.deepEqual(seen, ['s1']);

  await def.execute('c', { sessionID: 'explicit1' }, undefined, undefined, ctx);
  assert.deepEqual(seen, ['s1', 'explicit1']);
});

test('a degraded runtime reports an error result instead of throwing', async () => {
  const pi = makePi();
  registerLcmTools(pi, () => ({ isDegraded: () => true, store: () => ({}) }));

  const def = pi.registered.find((d) => d.name === 'lcm_grep');
  const result = await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unavailable/i);
});

test('an uninitialized runtime reports an error result', async () => {
  const pi = makePi();
  registerLcmTools(pi, () => undefined);
  const def = pi.registered.find((d) => d.name === 'lcm_status');
  const result = await def.execute('c', {}, undefined, undefined, ctx);
  assert.equal(result.isError, true);
});

test('a throwing store surfaces as an error result', async () => {
  const pi = makePi();
  registerLcmTools(pi, () =>
    runtimeWith({
      async lineage() {
        throw new Error('db gone');
      },
    }),
  );
  const def = pi.registered.find((d) => d.name === 'lcm_lineage');
  const result = await def.execute('c', {}, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /db gone/);
});

test('lcm_grep formats results and reports an empty search', async () => {
  const pi = makePi();
  let results = [];
  registerLcmTools(pi, () =>
    runtimeWith({
      async grep() {
        return results;
      },
    }),
  );
  const def = pi.registered.find((d) => d.name === 'lcm_grep');

  const empty = await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  assert.match(empty.content[0].text, /No archived matches/);

  results = [{ type: 'message', sessionID: 's1', snippet: 'tenant mapping' }];
  const hit = await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  assert.match(hit.content[0].text, /\[message\] session=s1 tenant mapping/);
});

test('lcm_grep defaults limit to 5', async () => {
  const pi = makePi();
  const seen = [];
  registerLcmTools(pi, () =>
    runtimeWith({
      async grep(input) {
        seen.push(input.limit);
        return [];
      },
    }),
  );
  const def = pi.registered.find((d) => d.name === 'lcm_grep');
  await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  await def.execute('c', { query: 'x', limit: 12 }, undefined, undefined, ctx);
  assert.deepEqual(seen, [5, 12]);
});

test('lcm_import_snapshot normalizes mode and worktreeMode', async () => {
  const pi = makePi();
  const calls = [];
  registerLcmTools(pi, () =>
    runtimeWith({
      async importSnapshot(input) {
        calls.push(input);
        return 'ok';
      },
    }),
  );
  const def = pi.registered.find((d) => d.name === 'lcm_import_snapshot');

  await def.execute('c', { filePath: 'a.json' }, undefined, undefined, ctx);
  assert.equal(calls[0].mode, 'replace', 'anything but merge is replace');
  assert.equal(calls[0].worktreeMode, 'auto');

  await def.execute(
    'c',
    { filePath: 'a.json', mode: 'merge', worktreeMode: 'preserve' },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(calls[1].mode, 'merge');
  assert.equal(calls[1].worktreeMode, 'preserve');

  await def.execute(
    'c',
    { filePath: 'a.json', worktreeMode: 'nonsense' },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(calls[2].worktreeMode, 'auto');
});

test('lcm_status renders scalar stats as key=value lines', async () => {
  const pi = makePi();
  registerLcmTools(pi, () =>
    runtimeWith({
      async stats() {
        return {
          schemaVersion: 2,
          sessionCount: 3,
          latestEventAt: null,
          eventTypes: { 'message.updated': 4 },
        };
      },
    }),
  );
  const def = pi.registered.find((d) => d.name === 'lcm_status');
  const result = await def.execute('c', {}, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /schemaVersion=2/);
  assert.match(text, /sessionCount=3/);
  assert.ok(!text.includes('eventTypes='), 'nested objects are not rendered as scalars');
});
