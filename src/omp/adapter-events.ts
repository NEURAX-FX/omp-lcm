import path from 'node:path';

import type { Event, Message, Part, ToolState } from '../wire-types.js';
import { toConversationMessages } from './adapter-messages.js';
import type { PendingToolCalls } from './pending-tools.js';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Concatenated text of an omp message's content blocks. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => asRecord(block))
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block?.text as string)
    .join('\n');
}

/**
 * Rebuild the tool part a `toolResult` belongs to, settled with its output.
 *
 * Returns undefined when the message is not a tool result, or when its call was
 * never archived (a result for a call from before this process started, or a
 * duplicate delivery) — those fall through to normal message archiving so output
 * is never silently dropped.
 */
function settleToolResult(
  sessionID: string,
  message: unknown,
  pending: PendingToolCalls,
): Part | undefined {
  const record = asRecord(message);
  if (record?.role !== 'toolResult') return undefined;

  const callID = record.toolCallId;
  if (typeof callID !== 'string') return undefined;

  const open = pending.take(callID);
  if (!open || open.sessionID !== sessionID) return undefined;

  const text = textOf(record.content);
  const state: ToolState =
    record.isError === true
      ? { status: 'error', input: open.input, error: text }
      : { status: 'completed', input: open.input, output: text };

  return {
    id: open.partID,
    messageID: open.messageID,
    sessionID: open.sessionID,
    type: 'tool',
    callID: open.callID,
    tool: open.tool,
    state,
  };
}

export type SessionEventKind = 'created' | 'updated' | 'deleted' | 'compacted';

export type SessionEventInput = {
  sessionID: string;
  title?: string;
  directory?: string;
  parentSessionID?: string;
};

/**
 * Resolve `SessionHeader.parentSession` into a session id.
 *
 * The field is an opaque lineage string: omp writes either a session id or a
 * session file path depending on the flow, and `session.md` warns it is
 * "metadata, not a typed foreign key". Session files are named
 * `<timestamp>_<sessionId>.jsonl`, so a path is reduced to its trailing id.
 * Anything unusable becomes undefined — the store's `parentID` is nullable
 * (store.ts:5508), so a missing lineage link is benign.
 */
export function parseParentSession(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!value.includes('/') && !value.includes('\\')) return value;

  const base = path.basename(value).replace(/\.jsonl$/, '');
  const separator = base.indexOf('_');
  const id = separator >= 0 ? base.slice(separator + 1) : base;
  return id.length > 0 ? id : undefined;
}

export function sessionEvent(kind: SessionEventKind, input: SessionEventInput): Event {
  const now = Date.now();
  // The session-info payload reuses the message wire shape, so it carries the
  // identity fields `getValidMessageInfo` requires (store.ts:365-381) in addition
  // to the session fields `applyEvent` reads (store.ts:5506-5514).
  const info: Message = {
    id: input.sessionID,
    sessionID: input.sessionID,
    role: 'session',
    time: { created: now, updated: now },
    title: input.title,
    directory: input.directory,
    parentID: input.parentSessionID,
  };

  if (kind === 'compacted') {
    return { type: 'session.compacted', properties: { sessionID: input.sessionID, info } };
  }
  return { type: `session.${kind}`, properties: { info } } as Event;
}

/**
 * Translate settled omp messages into the store's capture stream.
 *
 * `message.updated` must precede its parts: the store looks the parent message
 * up by id when applying a part update (store.ts:2399-2409).
 *
 * When `pending` is supplied, a `toolResult` whose call was archived by an
 * earlier invocation re-emits `message.part.updated` for that ORIGINAL part
 * instead of archiving a new message. omp delivers the assistant turn and each
 * tool result through separate `message_end` events, so without this the tool
 * part would stay `status: "pending"` forever and its output would be archived
 * as an unrelated text part — which also defeats the store's tool-output privacy
 * redaction (store-artifacts.ts:331-341).
 */
export function messageEvents(
  sessionID: string,
  messages: unknown[],
  pending?: PendingToolCalls,
): Event[] {
  const events: Event[] = [];
  const carried: unknown[] = [];

  for (const message of messages) {
    const settled = pending ? settleToolResult(sessionID, message, pending) : undefined;
    if (settled) {
      events.push({ type: 'message.part.updated', properties: { part: settled } });
      continue;
    }
    carried.push(message);
  }

  for (const conv of toConversationMessages(sessionID, carried)) {
    events.push({ type: 'message.updated', properties: { info: conv.info } });
    for (const part of conv.parts) {
      events.push({ type: 'message.part.updated', properties: { part } });
    }
    pending?.record([conv]);
  }

  return events;
}
