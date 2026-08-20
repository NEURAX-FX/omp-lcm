import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadOptions } from '../dist/omp/config.js';

function makeRoots() {
  const base = mkdtempSync(path.join(tmpdir(), 'omp-lcm-config-'));
  const cwd = path.join(base, 'work');
  const agentDir = path.join(base, 'agent');
  mkdirSync(path.join(cwd, '.omp'), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  return { base, cwd, agentDir };
}

test('defaults apply with no config files present', () => {
  const { base, cwd, agentDir } = makeRoots();
  try {
    const options = loadOptions(cwd, agentDir);
    assert.equal(options.automaticRetrieval.enabled, true);
    assert.equal(options.freshTailMessages, 10);
    assert.equal(options.scopeDefaults.grep, 'session');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('project config overrides user config', () => {
  const { base, cwd, agentDir } = makeRoots();
  try {
    writeFileSync(
      path.join(agentDir, 'lcm.json'),
      JSON.stringify({ freshTailMessages: 20, summaryCharBudget: 999 }),
    );
    writeFileSync(path.join(cwd, '.omp', 'lcm.json'), JSON.stringify({ freshTailMessages: 30 }));
    const options = loadOptions(cwd, agentDir);
    assert.equal(options.freshTailMessages, 30, 'project wins');
    assert.equal(options.summaryCharBudget, 999, 'user value survives where project is silent');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('nested objects merge instead of replacing wholesale', () => {
  const { base, cwd, agentDir } = makeRoots();
  try {
    writeFileSync(
      path.join(agentDir, 'lcm.json'),
      JSON.stringify({ retention: { staleSessionDays: 90, orphanBlobDays: 7 } }),
    );
    writeFileSync(
      path.join(cwd, '.omp', 'lcm.json'),
      JSON.stringify({ retention: { orphanBlobDays: 21 } }),
    );
    const options = loadOptions(cwd, agentDir);
    assert.equal(options.retention.orphanBlobDays, 21, 'project wins for the shared key');
    assert.equal(options.retention.staleSessionDays, 90, 'user-only key is not dropped');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('env overrides both config files', () => {
  const { base, cwd, agentDir } = makeRoots();
  const previous = process.env.OMP_LCM_FRESH_TAIL_MESSAGES;
  try {
    writeFileSync(path.join(cwd, '.omp', 'lcm.json'), JSON.stringify({ freshTailMessages: 30 }));
    process.env.OMP_LCM_FRESH_TAIL_MESSAGES = '7';
    assert.equal(loadOptions(cwd, agentDir).freshTailMessages, 7);
  } finally {
    if (previous === undefined) delete process.env.OMP_LCM_FRESH_TAIL_MESSAGES;
    else process.env.OMP_LCM_FRESH_TAIL_MESSAGES = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('OMP_LCM_AUTOMATIC_RETRIEVAL disables recall', () => {
  const { base, cwd, agentDir } = makeRoots();
  const previous = process.env.OMP_LCM_AUTOMATIC_RETRIEVAL;
  try {
    process.env.OMP_LCM_AUTOMATIC_RETRIEVAL = '0';
    assert.equal(loadOptions(cwd, agentDir).automaticRetrieval.enabled, false);
  } finally {
    if (previous === undefined) delete process.env.OMP_LCM_AUTOMATIC_RETRIEVAL;
    else process.env.OMP_LCM_AUTOMATIC_RETRIEVAL = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('an env override does not wipe sibling config keys', () => {
  const { base, cwd, agentDir } = makeRoots();
  const previous = process.env.OMP_LCM_AUTOMATIC_RETRIEVAL;
  try {
    writeFileSync(
      path.join(cwd, '.omp', 'lcm.json'),
      JSON.stringify({ automaticRetrieval: { enabled: true, maxMessageHits: 5 } }),
    );
    process.env.OMP_LCM_AUTOMATIC_RETRIEVAL = '0';
    const options = loadOptions(cwd, agentDir);
    assert.equal(options.automaticRetrieval.enabled, false);
    assert.equal(options.automaticRetrieval.maxMessageHits, 5);
  } finally {
    if (previous === undefined) delete process.env.OMP_LCM_AUTOMATIC_RETRIEVAL;
    else process.env.OMP_LCM_AUTOMATIC_RETRIEVAL = previous;
    rmSync(base, { recursive: true, force: true });
  }
});

test('malformed json falls back to defaults instead of throwing', () => {
  const { base, cwd, agentDir } = makeRoots();
  try {
    writeFileSync(path.join(cwd, '.omp', 'lcm.json'), '{ not json');
    const options = loadOptions(cwd, agentDir);
    assert.equal(options.freshTailMessages, 10);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a non-object config body is ignored', () => {
  const { base, cwd, agentDir } = makeRoots();
  try {
    writeFileSync(path.join(cwd, '.omp', 'lcm.json'), '[1,2,3]');
    assert.equal(loadOptions(cwd, agentDir).freshTailMessages, 10);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
