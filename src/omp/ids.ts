import { hashContent } from '../utils.js';

export type AgentMessageLike = {
  role: string;
  content: unknown;
  timestamp?: number;
};

/** Field separator. Prevents ("a","b") and ("ab","") hashing alike. */
const FIELD_SEP = '\u0001';
/** Content-block separator, for the same reason within an array. */
const BLOCK_SEP = '\u0000';

/** Stable digest of a message's content. Order-sensitive: a reordered assistant
 *  turn is a different turn, so it must hash differently. */
function contentDigest(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content.map((block) => JSON.stringify(block)).join(BLOCK_SEP);
}

/**
 * Content-addressed message id.
 *
 * A monotonic counter cannot be used: it restarts at zero when a session is
 * resumed, so the same message would archive twice under different ids. Hashing
 * (session, role, timestamp, content) is idempotent across processes, which is
 * what the store's `messages.message_id` primary key needs.
 *
 * omp messages carry no host-assigned id (pi-ai/src/types.ts:833-964), and the
 * session entry ids that do exist may not be persisted yet when `message_end`
 * fires, so they cannot be borrowed here.
 */
export function messageId(sessionID: string, message: AgentMessageLike): string {
  const fields = [
    sessionID,
    message.role,
    String(message.timestamp ?? 0),
    contentDigest(message.content),
  ];
  return `m_${hashContent(fields.join(FIELD_SEP)).slice(0, 16)}`;
}

export function partId(messageID: string, index: number): string {
  return `${messageID}_p${index}`;
}
