import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyRecalledContent,
  toConversationMessage,
  toConversationMessages,
} from '../dist/omp/adapter-messages.js';
import { isValidWireMessage, isValidWirePart } from '../dist/wire-types.js';

const userMsg = { role: 'user', content: 'find the tenant mapping', timestamp: 1000 };

const assistantMsg = {
  role: 'assistant',
  content: [
    { type: 'thinking', thinking: 'considering' },
    { type: 'text', text: 'here it is' },
    { type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: 'a.ts' } },
  ],
  api: 'anthropic',
  provider: 'anthropic',
  model: 'claude-opus-4',
  usage: { input: 10, output: 5 },
  stopReason: 'toolUse',
  providerPayload: { opaque: true },
  timestamp: 2000,
};

const toolResultMsg = {
  role: 'toolResult',
  toolCallId: 'call_1',
  toolName: 'read',
  content: [{ type: 'text', text: 'file body' }],
  isError: false,
  details: { lines: 3 },
  timestamp: 2500,
};

test('user message maps to a store-valid conversation message', () => {
  const conv = toConversationMessage('s1', userMsg);
  assert.ok(conv);
  assert.equal(isValidWireMessage(conv.info), true);
  assert.equal(conv.info.sessionID, 's1');
  assert.equal(conv.info.role, 'user');
  assert.equal(conv.info.time.created, 1000);
  assert.equal(conv.parts.length, 1);
  assert.equal(conv.parts[0].type, 'text');
  assert.equal(conv.parts[0].text, 'find the tenant mapping');
  for (const part of conv.parts) assert.equal(isValidWirePart(part), true);
});

test('assistant blocks map to reasoning, text, and tool parts in order', () => {
  const conv = toConversationMessage('s1', assistantMsg);
  assert.ok(conv);
  assert.deepEqual(
    conv.parts.map((p) => p.type),
    ['reasoning', 'text', 'tool'],
  );
  const toolPart = conv.parts[2];
  assert.equal(toolPart.callID, 'call_1');
  assert.equal(toolPart.tool, 'read');
  assert.equal(toolPart.state.status, 'pending');
  for (const part of conv.parts) assert.equal(isValidWirePart(part), true);
});

test('toolResult merges into the tool part of its originating call', () => {
  const conv = toConversationMessages('s1', [assistantMsg, toolResultMsg]);
  assert.equal(conv.length, 1, 'toolResult must not become its own message');
  const toolPart = conv[0].parts.find((p) => p.type === 'tool');
  assert.equal(toolPart.state.status, 'completed');
  assert.equal(toolPart.state.output, 'file body');
});

test('errored toolResult maps to an error tool state', () => {
  const conv = toConversationMessages('s1', [
    assistantMsg,
    { ...toolResultMsg, isError: true, content: [{ type: 'text', text: 'boom' }] },
  ]);
  const toolPart = conv[0].parts.find((p) => p.type === 'tool');
  assert.equal(toolPart.state.status, 'error');
  assert.equal(toolPart.state.error, 'boom');
});

test('an orphan toolResult still archives as its own message', () => {
  const conv = toConversationMessages('s1', [toolResultMsg]);
  assert.equal(conv.length, 1);
  assert.equal(conv[0].info.role, 'toolResult');
  assert.equal(isValidWireMessage(conv[0].info), true);
});

test('ids are stable across repeated mapping', () => {
  const first = toConversationMessage('s1', userMsg);
  const second = toConversationMessage('s1', userMsg);
  assert.equal(first.info.id, second.info.id);
  assert.equal(first.parts[0].id, second.parts[0].id);
});

test('unmappable input is skipped rather than throwing', () => {
  assert.equal(toConversationMessage('s1', null), undefined);
  assert.equal(toConversationMessage('s1', { content: 'no role' }), undefined);
  assert.equal(toConversationMessages('s1', [null, userMsg]).length, 1);
});

test('applyRecalledContent replaces content but preserves provider fields', () => {
  const originals = [assistantMsg];
  const conv = toConversationMessages('s1', originals);
  conv[0].parts.push({
    id: 'synthetic_1',
    messageID: conv[0].info.id,
    sessionID: 's1',
    type: 'text',
    text: '[Archived recall] tenant mapping lives in db.ts',
  });

  const [result] = applyRecalledContent('s1', originals, conv);
  assert.notEqual(result, assistantMsg, 'must not mutate the caller object');
  assert.equal(result.api, 'anthropic');
  assert.equal(result.provider, 'anthropic');
  assert.equal(result.model, 'claude-opus-4');
  assert.equal(result.stopReason, 'toolUse');
  assert.deepEqual(result.providerPayload, { opaque: true });
  assert.deepEqual(result.usage, { input: 10, output: 5 });
  assert.equal(result.timestamp, 2000);
  const texts = result.content.filter((b) => b.type === 'text').map((b) => b.text);
  assert.ok(texts.some((t) => t.includes('tenant mapping lives in db.ts')));
  assert.ok(
    result.content.some((b) => b.type === 'toolCall' && b.id === 'call_1'),
    'tool calls must survive the round trip',
  );
});

test('applyRecalledContent passes through messages the store dropped', () => {
  const originals = [userMsg, assistantMsg];
  const result = applyRecalledContent('s1', originals, []);
  assert.deepEqual(result, originals);
});

test('applyRecalledContent keeps a toolResult message intact', () => {
  const originals = [assistantMsg, toolResultMsg];
  const conv = toConversationMessages('s1', originals);
  const result = applyRecalledContent('s1', originals, conv);
  assert.equal(result.length, 2, 'the merged toolResult must still be delivered');
  const tail = result[1];
  assert.equal(tail.role, 'toolResult');
  assert.equal(tail.toolCallId, 'call_1');
  assert.equal(tail.toolName, 'read');
  assert.equal(tail.isError, false);
  assert.deepEqual(tail.details, { lines: 3 });
});
