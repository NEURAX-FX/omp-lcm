import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidWireMessage, isValidWirePart } from '../dist/wire-types.js';

test('isValidWireMessage mirrors store getValidMessageInfo', () => {
  const ok = { id: 'm1', sessionID: 's1', role: 'user', time: { created: 1 } };
  assert.equal(isValidWireMessage(ok), true);
  assert.equal(isValidWireMessage({ ...ok, id: 42 }), false);
  assert.equal(isValidWireMessage({ ...ok, time: {} }), false);
  assert.equal(isValidWireMessage({ ...ok, time: { created: Number.NaN } }), false);
  assert.equal(isValidWireMessage(null), false);
});

test('isValidWirePart requires id, messageID, sessionID, type', () => {
  const ok = { id: 'p1', messageID: 'm1', sessionID: 's1', type: 'text' };
  assert.equal(isValidWirePart(ok), true);
  assert.equal(isValidWirePart({ ...ok, messageID: undefined }), false);
});
