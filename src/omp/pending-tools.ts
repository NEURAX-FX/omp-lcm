import type { ConversationMessage } from '../types.js';
import type { ToolPart } from '../wire-types.js';

/** Where an unsettled tool call was archived, so its result can be folded into
 *  that same part instead of landing as a separate message. */
export type PendingToolCall = {
  callID: string;
  tool: string;
  messageID: string;
  partID: string;
  sessionID: string;
  input: Record<string, unknown>;
};

export type PendingToolCalls = {
  record(conv: ConversationMessage[]): void;
  take(callID: string): PendingToolCall | undefined;
  size(): number;
  clear(): void;
};

/** A turn rarely has more than a handful of open calls; the cap only exists so a
 *  session whose results never arrive cannot grow the map without bound. */
const DEFAULT_MAX_PENDING = 256;

/**
 * Tracks tool calls archived without a result yet.
 *
 * omp delivers an assistant turn and each tool result through separate
 * `message_end` events, so the archive path sees one message at a time and the
 * call/result merge in `toConversationMessages` never fires there. Without this
 * registry a tool part stays `status: "pending"` forever and its output is
 * archived as an unrelated text part — which also defeats the store's
 * tool-output privacy redaction (store-artifacts.ts:331-341) and mislabels
 * externalized output as message text.
 *
 * Insertion order matters for eviction, so this is a Map rather than a record.
 */
export function createPendingToolCalls(maxPending = DEFAULT_MAX_PENDING): PendingToolCalls {
  const pending = new Map<string, PendingToolCall>();

  return {
    record(conv) {
      for (const message of conv) {
        for (const part of message.parts) {
          if (part.type !== 'tool') continue;
          const tool = part as ToolPart;
          // A call that already carries a result needs no follow-up.
          if (tool.state.status === 'completed' || tool.state.status === 'error') continue;

          pending.set(tool.callID, {
            callID: tool.callID,
            tool: tool.tool,
            messageID: message.info.id,
            partID: tool.id,
            sessionID: message.info.sessionID,
            input: tool.state.input ?? {},
          });

          if (pending.size > maxPending) {
            const oldest = pending.keys().next();
            if (!oldest.done) pending.delete(oldest.value);
          }
        }
      }
    },

    take(callID) {
      const record = pending.get(callID);
      if (record) pending.delete(callID);
      return record;
    },

    size() {
      return pending.size;
    },

    clear() {
      pending.clear();
    },
  };
}
