import type { ConversationMessage } from '../types.js';
import type { Message, Part, ToolPart, ToolState } from '../wire-types.js';
import { type AgentMessageLike, messageId, partId } from './ids.js';

/** Provider fields that must survive a recall round trip. Dropping them breaks
 *  transport-native replay (pi-ai/src/types.ts:892-962). */
const PRESERVED_KEYS = [
  'api',
  'provider',
  'model',
  'usage',
  'stopReason',
  'stopDetails',
  'providerPayload',
  'responseId',
  'timestamp',
  'synthetic',
  'steering',
  'attribution',
  'toolCallId',
  'toolName',
  'isError',
  'details',
] as const;

/** Message-info fields worth carrying into the archive for display/debugging. */
const INFO_PASSTHROUGH_KEYS = ['api', 'provider', 'model', 'usage', 'stopReason'] as const;

type Block = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function blocksOf(content: unknown): Block[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Block => Boolean(asRecord(block)));
}

function textOfBlocks(blocks: Block[]): string {
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n');
}

function toPart(sessionID: string, messageID: string, index: number, block: Block): Part {
  const base = { id: partId(messageID, index), messageID, sessionID };

  switch (block.type) {
    case 'text':
      return { ...base, type: 'text', text: String(block.text ?? '') };
    case 'thinking':
      return { ...base, type: 'reasoning', text: String(block.thinking ?? '') };
    case 'toolCall':
      return {
        ...base,
        type: 'tool',
        callID: typeof block.id === 'string' ? block.id : base.id,
        tool: String(block.name ?? 'unknown'),
        state: { status: 'pending', input: asRecord(block.arguments) ?? {} },
      };
    case 'image':
      return {
        ...base,
        type: 'file',
        mime: typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream',
      };
    default:
      // Kinds this port does not model (redactedThinking, Anthropic server tools,
      // future additions) are archived opaquely under `raw` rather than dropped:
      // the store serializes parts as-is, and `applyRecalledContent` restores
      // them unchanged. The wire union is closed, so an unmodelled kind is
      // archived as a text part carrying its original payload alongside.
      return {
        ...base,
        type: 'text',
        text: '',
        rawType: String(block.type ?? 'unknown'),
        raw: block,
      };
  }
}

/**
 * Map one omp message into the store's conversation shape.
 *
 * Returns undefined when the input cannot satisfy the store's own validation
 * (store.ts:365-381), so callers skip it instead of poisoning the archive.
 */
export function toConversationMessage(
  sessionID: string,
  message: unknown,
): ConversationMessage | undefined {
  const record = asRecord(message);
  if (!record || typeof record.role !== 'string') return undefined;

  const like: AgentMessageLike = {
    role: record.role,
    content: record.content,
    timestamp: typeof record.timestamp === 'number' ? record.timestamp : undefined,
  };
  const id = messageId(sessionID, like);

  const info: Message = {
    id,
    sessionID,
    role: record.role,
    time: { created: like.timestamp ?? Date.now() },
  };
  // Written through a record view: omp reports `model` as a plain id string,
  // while the opencode wire shape declares it as `{ providerID, modelID }`. The
  // store only ever serializes this field (store.ts:1248), so the archived value
  // is kept as the host reported it rather than being coerced or dropped.
  const infoFields = info as Record<string, unknown>;
  for (const key of INFO_PASSTHROUGH_KEYS) {
    const value = record[key];
    if (value !== undefined && value !== null) infoFields[key] = value;
  }

  const parts = blocksOf(record.content).map((block, index) => toPart(sessionID, id, index, block));

  return { info, parts };
}

/**
 * Fold a toolResult into the tool part of the assistant turn that issued the
 * call. opencode models a call and its result as ONE part; omp splits them into
 * two messages, so the result has to be merged back in.
 */
function mergeToolResult(conv: ConversationMessage[], record: Record<string, unknown>): boolean {
  const callId = record.toolCallId;
  if (typeof callId !== 'string') return false;

  for (let i = conv.length - 1; i >= 0; i--) {
    const target = conv[i].parts.find(
      (part): part is ToolPart => part.type === 'tool' && part.callID === callId,
    );
    if (!target) continue;

    const text = textOfBlocks(blocksOf(record.content));
    const input = target.state.input ?? {};
    const state: ToolState =
      record.isError === true
        ? { status: 'error', input, error: text }
        : { status: 'completed', input, output: text };
    target.state = state;
    return true;
  }
  return false;
}

export function toConversationMessages(
  sessionID: string,
  messages: unknown[],
): ConversationMessage[] {
  const conv: ConversationMessage[] = [];
  for (const message of messages) {
    const record = asRecord(message);
    if (record?.role === 'toolResult' && mergeToolResult(conv, record)) continue;
    const mapped = toConversationMessage(sessionID, message);
    if (mapped) conv.push(mapped);
  }
  return conv;
}

function partsToBlocks(parts: Part[]): Block[] {
  const blocks: Block[] = [];

  for (const part of parts) {
    switch (part.type) {
      case 'text':
        blocks.push({ type: 'text', text: part.text ?? '' });
        break;
      case 'reasoning':
        blocks.push({ type: 'thinking', thinking: part.text ?? '' });
        break;
      case 'tool':
        blocks.push({
          type: 'toolCall',
          id: part.callID,
          name: part.tool,
          arguments: part.state.input ?? {},
        });
        break;
      default: {
        const raw = asRecord((part as { raw?: unknown }).raw);
        if (raw) blocks.push(raw);
        break;
      }
    }
  }

  return blocks;
}

/**
 * Rebuild omp messages from store-rewritten conversation messages.
 *
 * The original message is the template: only `content` is replaced, and every
 * provider field is copied verbatim. Messages the store dropped, and those that
 * never mapped (a toolResult merged into its assistant turn), pass through
 * untouched — omp validates the array it gets back, so silently losing a
 * toolResult would break the tool-call/result pairing.
 */
export function applyRecalledContent(
  sessionID: string,
  original: unknown[],
  conv: ConversationMessage[],
): unknown[] {
  if (conv.length === 0) return original;

  const byId = new Map(conv.map((entry) => [entry.info.id, entry]));
  const result: unknown[] = [];

  for (const message of original) {
    const record = asRecord(message);
    if (!record || typeof record.role !== 'string') {
      result.push(message);
      continue;
    }

    const id = messageId(sessionID, {
      role: record.role,
      content: record.content,
      timestamp: typeof record.timestamp === 'number' ? record.timestamp : undefined,
    });
    const rewritten = byId.get(id);
    if (!rewritten) {
      result.push(message);
      continue;
    }

    const next: Record<string, unknown> = { role: record.role };
    for (const key of PRESERVED_KEYS) {
      if (record[key] !== undefined) next[key] = record[key];
    }
    next.content = partsToBlocks(rewritten.parts);
    result.push(next);
  }

  return result;
}
