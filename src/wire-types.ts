/** Wire shapes archived by the store. Ported from @opencode-ai/sdk.
 *
 *  These are boundary types. Two competing requirements shape them:
 *
 *  1. Inside a `switch (part.type)` the store treats that variant's own fields
 *     as present (`storedPart.state.output` is passed to a `string` parameter,
 *     store-artifacts.ts:344), so a variant's own fields must be REQUIRED.
 *  2. The store also reads foreign fields without narrowing, and persists every
 *     part as opaque JSON (store.ts:1248), so unknown fields must survive a
 *     round trip. Hence the shared index signature on `PartBase`.
 *
 *  Required-field sets are taken from what the store actually validates
 *  (store.ts:365-381 for messages, store.ts:462-471 for parts) and from the
 *  payloads the host emits (mirrored by tests/helpers.mjs:138-221). */

export type MessageTime = { created: number; updated?: number; completed?: number };

export type Message = {
  id: string;
  sessionID: string;
  role: string;
  time: MessageTime;
  parentID?: string;
  /** Session-info payloads reuse this shape; the store reads both when applying
   *  `session.created` / `session.updated` / `session.deleted` (store.ts:5506-5514). */
  title?: string;
  directory?: string;
  agent?: string;
  mode?: string;
  modelID?: string;
  providerID?: string;
  model?: { providerID: string; modelID: string };
  [key: string]: unknown;
};

export type PartTime = { start: number; end?: number };

/** Discriminated on `status`: a completed call has `output`, an errored one has
 *  `error`, and neither exists before the call settles. */
export type ToolStateCompleted = {
  status: 'completed';
  input: Record<string, unknown>;
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: PartTime;
  attachments?: FilePart[];
};

export type ToolStateError = {
  status: 'error';
  input: Record<string, unknown>;
  error: string;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: PartTime;
};

export type ToolStatePending = {
  status: 'pending' | 'running';
  input?: Record<string, unknown>;
  title?: string;
  metadata?: Record<string, unknown>;
  time?: PartTime;
};

export type ToolState = ToolStateCompleted | ToolStateError | ToolStatePending;

export type FileSourceText = { value: string; start: number; end: number };

export type FileSource = {
  path?: string;
  type?: string;
  text?: FileSourceText;
};

/** Identity fields the store requires of every part (store.ts:462-471), plus an
 *  index signature so foreign and future fields are readable and preserved. */
export type PartBase = {
  id: string;
  messageID: string;
  sessionID: string;
  [key: string]: unknown;
};

export type TextPart = PartBase & {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = PartBase & {
  type: 'reasoning';
  text: string;
  metadata?: Record<string, unknown>;
  time?: PartTime;
};

export type ToolPart = PartBase & {
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
};

export type FilePart = PartBase & {
  type: 'file';
  filename?: string;
  mime?: string;
  url?: string;
  source?: FileSource;
};

export type SnapshotPart = PartBase & { type: 'snapshot'; snapshot: string };

/** Agent parts carry an inline text range under `source`, not a file reference
 *  (tests/helpers.mjs:223-232). */
export type AgentSource = { value: string; start: number; end: number };
export type AgentPart = PartBase & { type: 'agent'; name: string; source?: AgentSource };

export type SubtaskPart = PartBase & {
  type: 'subtask';
  prompt: string;
  description: string;
  agent?: string;
};

/** `files` is the changed-path list the store folds into its file index
 *  (store.ts:654, 4441). */
export type PatchPart = PartBase & { type: 'patch'; files: string[]; hash?: string };

/** Closed union: these are every kind the store dispatches on
 *  (store.ts:523, 584, 4400 and store-artifacts.ts:311).
 *
 *  Deliberately NO catch-all `{ type: string }` variant. One would overlap every
 *  case, so `case 'tool'` would narrow to `ToolPart | CatchAll` and `state` would
 *  degrade to `unknown` through the index signature — exactly the failure this
 *  shape was rewritten to avoid. An unrecognized kind from a future host still
 *  parses at runtime (nothing validates against this union); it just needs a
 *  variant added here before new code can narrow to it. */
export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | SnapshotPart
  | AgentPart
  | SubtaskPart
  | PatchPart;

/** Events the store captures.
 *
 *  A discriminated union, not `properties: Record<string, unknown>`: the store
 *  narrows on `event.type` and then reads `properties.info` / `properties.part`
 *  as typed values (store.ts:1073, 2376, 5506, 5543). A generic record would
 *  degrade every one of those reads to `unknown`.
 *
 *  `timestamp` / `time` are read defensively at store.ts:339-341 for any event,
 *  so they live on the shared base rather than on one variant. */
export type EventBase = {
  timestamp?: number;
  time?: number;
};

export type SessionEventProperties = EventBase & { info: Message };

export type SessionCreatedEvent = {
  type: 'session.created';
  properties: SessionEventProperties;
};
export type SessionUpdatedEvent = {
  type: 'session.updated';
  properties: SessionEventProperties;
};
export type SessionDeletedEvent = {
  type: 'session.deleted';
  properties: SessionEventProperties;
};
export type SessionCompactedEvent = {
  type: 'session.compacted';
  properties: EventBase & { sessionID: string; info?: Message };
};
export type SessionErrorEvent = {
  type: 'session.error';
  properties: EventBase & { sessionID?: string; error?: unknown };
};

export type MessageUpdatedEvent = {
  type: 'message.updated';
  properties: EventBase & { info: Message };
};
export type MessageRemovedEvent = {
  type: 'message.removed';
  properties: EventBase & { sessionID: string; messageID: string };
};
export type MessagePartUpdatedEvent = {
  type: 'message.part.updated';
  properties: EventBase & { part: Part };
};
export type MessagePartRemovedEvent = {
  type: 'message.part.removed';
  properties: EventBase & { sessionID: string; messageID: string; partID: string };
};

/** Closed union, deliberately with NO catch-all variant.
 *
 *  `Exclude<string, 'literal'>` collapses back to `string`, so a catch-all would
 *  overlap every case: narrowing on `event.type === 'message.part.updated'`
 *  would yield `MessagePartUpdatedEvent | CatchAll` and `properties.part` would
 *  degrade to `unknown` through the record type. Unrecognized kinds still flow
 *  through `captureDeferred` at runtime (`normalizeEvent` at store.ts:473 only
 *  requires a string `type`); they simply need a variant here before new code
 *  can narrow to them. */
export type Event =
  | SessionCreatedEvent
  | SessionUpdatedEvent
  | SessionDeletedEvent
  | SessionCompactedEvent
  | SessionErrorEvent
  | MessageUpdatedEvent
  | MessageRemovedEvent
  | MessagePartUpdatedEvent
  | MessagePartRemovedEvent;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** Mirrors store.ts:365-381 getValidMessageInfo. Keep the two in sync. */
export function isValidWireMessage(info: unknown): boolean {
  const record = asRecord(info);
  if (!record) return false;
  const time = asRecord(record.time);
  return (
    typeof record.id === 'string' &&
    typeof record.sessionID === 'string' &&
    typeof record.role === 'string' &&
    typeof time?.created === 'number' &&
    Number.isFinite(time.created)
  );
}

/** Mirrors store.ts:462-471 isValidMessagePartUpdate, plus the `type` field. */
export function isValidWirePart(part: unknown): boolean {
  const record = asRecord(part);
  if (!record) return false;
  return (
    typeof record.id === 'string' &&
    typeof record.messageID === 'string' &&
    typeof record.sessionID === 'string' &&
    typeof record.type === 'string'
  );
}
