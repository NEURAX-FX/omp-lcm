import path from 'node:path';

import type { Event, Message } from '../wire-types.js';
import { toConversationMessages } from './adapter-messages.js';

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
 */
export function messageEvents(sessionID: string, messages: unknown[]): Event[] {
  const events: Event[] = [];

  for (const conv of toConversationMessages(sessionID, messages)) {
    events.push({ type: 'message.updated', properties: { info: conv.info } });
    for (const part of conv.parts) {
      events.push({ type: 'message.part.updated', properties: { part } });
    }
  }

  return events;
}
