import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BASE_OPTIONS = {
  interop: { contextMode: true, neverOverrideCompactionPrompt: true, ignoreToolPrefixes: ['ctx_'] },
  scopeDefaults: { grep: 'session', describe: 'session' },
  scopeProfiles: [],
  retention: { staleSessionDays: undefined, deletedSessionDays: 30, orphanBlobDays: 14 },
  privacy: { excludeToolPrefixes: [], excludePathPatterns: [], redactPatterns: [] },
  automaticRetrieval: {
    enabled: true,
    maxChars: 900,
    minTokens: 2,
    maxMessageHits: 2,
    maxSummaryHits: 1,
    maxArtifactHits: 1,
    scopeOrder: ['session', 'root', 'worktree'],
    scopeBudgets: { session: 16, root: 12, worktree: 8, all: 6 },
    stop: { targetHits: 3, stopOnFirstScopeWithHits: false },
  },
  compactContextLimit: 1200,
  systemHint: true,
  storeDir: '.lcm',
  freshTailMessages: 2,
  minMessagesForTransform: 4,
  summaryCharBudget: 900,
  partCharBudget: 120,
  largeContentThreshold: 80,
  artifactPreviewChars: 90,
  artifactViewChars: 1200,
  binaryPreviewProviders: ['fingerprint'],
  previewBytePeek: 8,
};

export function makeWorkspace(prefix) {
  return mkdtempSync(path.join(tmpdir(), `${prefix}-`));
}

export async function cleanupWorkspace(workspace) {
  // On Windows, SQLite may hold file handles briefly after close().
  // Retry with exponential backoff to avoid EBUSY failures.
  let attempt = 0;
  while (attempt < 8) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      return;
    } catch (err) {
      if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
      attempt++;
      if (attempt >= 8) throw err;
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}

/**
 * Make `file` unwritable for THIS process, then restore it.
 *
 * `chmod 0o444` is not enough under uid 0: the kernel's `DAC_OVERRIDE` lets root
 * write any file regardless of mode, so the store never sees the `EACCES`/`EPERM`/
 * `EROFS` or `attempt to write a readonly database` error its fallback keys on
 * (src/store.ts:771-781) and the test silently exercises nothing. As root the
 * immutable attribute is used instead, which the kernel enforces for every uid.
 *
 * Returns a restore function. Callers MUST invoke it in `finally`, otherwise an
 * immutable file cannot be unlinked and workspace cleanup fails.
 */
export function withUnwritableFile(file) {
  if (process.getuid?.() !== 0) {
    chmodSync(file, 0o444);
    return () => {
      if (existsSync(file)) chmodSync(file, 0o666);
    };
  }

  try {
    execFileSync('chattr', ['+i', file], { stdio: 'pipe' });
  } catch (error) {
    // ext4/xfs support this; tmpfs and overlayfs may not.
    throw new Error(
      `cannot make ${file} unwritable as root: chattr +i failed (${error.message}). ` +
        'Run this test as an unprivileged user or on a filesystem supporting immutability.',
    );
  }

  return () => {
    if (!existsSync(file)) return;
    execFileSync('chattr', ['-i', file], { stdio: 'pipe' });
    chmodSync(file, 0o666);
  };
}

export function makeOptions(overrides = {}) {
  return {
    ...BASE_OPTIONS,
    ...overrides,
    interop: { ...BASE_OPTIONS.interop, ...overrides.interop },
    scopeDefaults: { ...BASE_OPTIONS.scopeDefaults, ...overrides.scopeDefaults },
    scopeProfiles: overrides.scopeProfiles ?? BASE_OPTIONS.scopeProfiles,
    retention: { ...BASE_OPTIONS.retention, ...overrides.retention },
    privacy: { ...BASE_OPTIONS.privacy, ...overrides.privacy },
    automaticRetrieval: {
      ...BASE_OPTIONS.automaticRetrieval,
      ...overrides.automaticRetrieval,
      scopeBudgets: {
        ...BASE_OPTIONS.automaticRetrieval.scopeBudgets,
        ...overrides.automaticRetrieval?.scopeBudgets,
      },
      stop: {
        ...BASE_OPTIONS.automaticRetrieval.stop,
        ...overrides.automaticRetrieval?.stop,
      },
    },
    binaryPreviewProviders: overrides.binaryPreviewProviders ?? BASE_OPTIONS.binaryPreviewProviders,
  };
}

export function sessionInfo(directory, id, created, parentID) {
  return {
    id,
    slug: id,
    projectID: 'p1',
    directory,
    parentID,
    title: id,
    version: '1',
    time: { created, updated: created },
  };
}

export function userInfo(sessionID, id, created) {
  return {
    id,
    sessionID,
    role: 'user',
    time: { created },
    agent: 'build',
    model: { providerID: 'openai', modelID: 'gpt-4.1' },
  };
}

export function assistantInfo(sessionID, id, created, parentID = 'u0') {
  return {
    id,
    sessionID,
    role: 'assistant',
    time: { created, completed: created + 1 },
    parentID,
    modelID: 'gpt-4.1',
    providerID: 'openai',
    mode: 'build',
    path: { cwd: sessionID, root: sessionID },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function messageInfo(sessionID, id, created, role = 'user') {
  return role === 'assistant'
    ? assistantInfo(sessionID, id, created)
    : userInfo(sessionID, id, created);
}

export function conversationMessage({ sessionID, messageID, created, role = 'user', parts = [] }) {
  return {
    info: messageInfo(sessionID, messageID, created, role),
    parts,
  };
}

export function textPart(sessionID, messageID, id, text, metadata) {
  return { id, sessionID, messageID, type: 'text', text, metadata };
}

export function reasoningPart(sessionID, messageID, id, text) {
  return { id, sessionID, messageID, type: 'reasoning', text, time: { start: 0, end: 1 } };
}

export function toolCompletedPart(sessionID, messageID, id, tool, output, attachments = []) {
  return {
    id,
    sessionID,
    messageID,
    type: 'tool',
    callID: `${id}-call`,
    tool,
    state: {
      status: 'completed',
      input: {},
      output,
      title: `Ran ${tool}`,
      metadata: {},
      time: { start: 0, end: 1 },
      attachments,
    },
  };
}

export function toolErrorPart(sessionID, messageID, id, tool, error) {
  return {
    id,
    sessionID,
    messageID,
    type: 'tool',
    callID: `${id}-call`,
    tool,
    state: {
      status: 'error',
      input: {},
      error,
      metadata: {},
      time: { start: 0, end: 1 },
    },
  };
}

export function writeFixtureFile(workspace, relativePath, content) {
  const filePath = path.join(workspace, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

export function filePart(
  sessionID,
  messageID,
  id,
  filePath,
  sourceText,
  mime = 'application/octet-stream',
) {
  return {
    id,
    sessionID,
    messageID,
    type: 'file',
    mime,
    filename: path.basename(filePath),
    url: pathToFileURL(filePath).href,
    source: {
      type: 'file',
      path: filePath,
      text: {
        value: sourceText,
        start: 0,
        end: sourceText.length,
      },
    },
  };
}

export function snapshotPart(sessionID, messageID, id, snapshot) {
  return { id, sessionID, messageID, type: 'snapshot', snapshot };
}

export function agentPart(sessionID, messageID, id, value) {
  return {
    id,
    sessionID,
    messageID,
    type: 'agent',
    name: 'explore',
    source: { value, start: 0, end: value.length },
  };
}

export function subtaskPart(sessionID, messageID, id, prompt, description) {
  return {
    id,
    sessionID,
    messageID,
    type: 'subtask',
    prompt,
    description,
    agent: 'general',
  };
}

export async function createSession(store, directory, sessionID, created, parentID) {
  await store.capture({
    type: 'session.created',
    properties: { sessionID, info: sessionInfo(directory, sessionID, created, parentID) },
  });
}

export async function captureMessage(
  store,
  { sessionID, messageID, created, role = 'user', parts = [] },
) {
  await store.capture({
    type: 'message.updated',
    properties: { sessionID, info: messageInfo(sessionID, messageID, created, role) },
  });

  for (const part of parts) {
    await store.capture({
      type: 'message.part.updated',
      properties: { sessionID, time: created, part },
    });
  }
}

export function makePluginContext(directory) {
  return {
    client: {},
    project: { id: 'p1' },
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost'),
    $: {},
  };
}

export function makeToolContext(directory, sessionID = 'root') {
  return {
    sessionID,
    messageID: 'tool-call',
    agent: 'test',
    directory,
    worktree: directory,
    abort: new AbortController().signal,
    metadata() {},
    async ask() {},
  };
}

export function firstNodeID(text) {
  return text.match(/sum_[a-f0-9]{12}_l\d+_p\d+/)?.[0];
}
