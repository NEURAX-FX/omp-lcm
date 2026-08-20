# omp-lcm 移植实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/root/opencode-lcm`（OpenCode 插件）移植为 omp extension，保留全部归档/召回/工具能力。

**Architecture:** 适配层路线。新增 `src/omp/` 把 omp 的 `AgentMessage` 与生命周期事件翻译成 opencode 的 `{info, parts}` / `Event` 形状，喂给原封不动的 `store.ts`（6,291 行）。召回改走 `context` 事件并 `return { messages }`。

**Tech Stack:** TypeScript、Bun、`bun:sqlite` / `node:sqlite`、`node:test`、biome。

**Spec:** `docs/superpowers/specs/2026-08-19-omp-lcm-port-design.md`

## Global Constraints

- 目标仓库 `/root/omp-lcm-kit`；源仓库 `/root/opencode-lcm` **只读**，绝不修改。
- 包名 `omp-lcm`。数据库路径保持 `<cwd>/.lcm/lcm.db`。
- `STORE_SCHEMA_VERSION` 保持 `2`（`src/constants.ts:12`），**不改 SQLite schema**。
- 全部环境变量前缀由 `OPENCODE_LCM_` 改为 `OMP_LCM_`；`OMP_LCM_SQLITE_RUNTIME`、`OMP_LCM_STARTUP_LOG` 保留，其余三个随 sidecar 删除。
- 移植后 `src/` 内**不得出现** `@opencode-ai` 任何导入。
- omp 扩展入口契约：默认导出一个接收 `ExtensionAPI` 的函数（`extension-loading.md`）。
- Node `>=22`（`node:sqlite` 的 `DatabaseSync` 需要）。
- 每个 task 结束时只跑该 task 相关的测试，不跑全量套件；全量验证在 Task 9。

## 关键类型契约（实现时必须遵守）

opencode 侧（store 消费，store 强校验这些字段）：

- `Message` 必须含 `{ id: string; sessionID: string; role: string; time: { created: number } }` —— `store.ts:365-381` 的 `getValidMessageInfo` 逐字段校验，缺一条整条消息被丢弃。
- `Part` 必须含 `{ id: string; messageID: string; sessionID: string; type: string }` —— `store.ts:462-471` 的 `isValidMessagePartUpdate`。
- `Event` 形状 `{ type: string; properties: Record<string, unknown> }`。

omp 侧（适配层输入）：

- `AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages]`（`pi-agent-core/src/types.ts:660`）
- `Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage`（`pi-ai/src/types.ts:964`），全部带 `timestamp: number`，**均无 id**。
- `ToolCall` 内容块带 `id`（`pi-ai/src/types.ts:797-801`）。

store 类：

- `SqliteLcmStore` 定义在 `store.ts:884`，构造签名 `(projectDir: string, options: OpencodeLcmOptions)`（`store.ts:909-917`），数据库落在 `path.join(projectDir, options.storeDir ?? '.lcm')/lcm.db`。
- 它**没有**写 `implements LcmStore`（对比 `node-sidecar-store.ts:74` 写了）。TypeScript 的结构化类型让 Task 7 的 `store: LcmStore` 注入照样成立——不要为此加 `implements`，也不要以为哪里出错了。`LcmStore` 的 23 个方法契约在 `lcm-store.ts:81-106`。

---

### Task 1: 仓库骨架与源码搬运

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`
- Create: `src/**`（从源仓库复制）
- Create: `tests/**`（从源仓库复制）

**Interfaces:**
- Consumes: 无
- Produces: 可编译的源码树；后续 task 全部在此之上改。

- [ ] **Step 1: 复制源码与测试**

```bash
cd /root/omp-lcm-kit
cp -r /root/opencode-lcm/src /root/opencode-lcm/tests .
cp /root/opencode-lcm/{tsconfig.json,biome.json,.gitignore} .
rm src/index.ts src/node-sidecar.ts src/node-sidecar-store.ts
rm tests/options-plugin.test.mjs
```

删除理由：`index.ts` 是 opencode 插件入口（Task 7 用 `src/omp/extension.ts` 取代）；
两个 sidecar 文件是 Bun-on-Windows 专用（spec §4.7）；`options-plugin.test.mjs`
测的是已删除的插件入口（Task 8 重写）。

- [ ] **Step 2: 写 package.json**

```json
{
  "name": "omp-lcm",
  "version": "0.1.0",
  "description": "Lossless context memory extension for omp",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=22" },
  "omp": { "extensions": ["./src/omp/extension.ts"] },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check src tests",
    "format": "biome format --write src tests",
    "test": "tsc -p tests/tsconfig.json && node --test tests/*.test.mjs dist-tests/*.test.js"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.10",
    "@types/node": "25.5.0",
    "typescript": "5.8.3"
  }
}
```

与源 `package.json` 的差异：去掉 `@opencode-ai/plugin` peer/dev 依赖与 `build` 步骤
（omp 直接加载 TS，无需 `tsc -p tsconfig.json` 产物），加 `omp.extensions` 清单键，
依赖版本从 `^` 改为精确锁定。

- [ ] **Step 3: 装依赖并确认基线失败**

Run: `cd /root/omp-lcm-kit && bun install && bun run typecheck`
Expected: FAIL，报 `Cannot find module '@opencode-ai/sdk'`（7 个文件）。
这正是 Task 2 要消除的。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: vendor opencode-lcm sources for omp port"
```

---

### Task 2: 本地 wire 类型，断开 opencode 依赖

**Files:**
- Create: `src/wire-types.ts`
- Create: `tests/wire-types.test.mjs`
- Modify: `src/types.ts:1`, `src/lcm-store.ts:1`, `src/preview-providers.ts:4`, `src/store-artifacts.ts:3`, `src/store.ts:6`

**Interfaces:**
- Consumes: 无
- Produces: `Message`、`Part`、`Event`、`ToolPart`、`FilePart`、`TextPart` 类型，
  从 `src/wire-types.ts` 导出。所有后续 task 用这些名字，不再提 `@opencode-ai/sdk`。

- [ ] **Step 1: 写失败测试**

```js
// tests/wire-types.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidWireMessage, isValidWirePart } from '../src/wire-types.js';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/wire-types.test.mjs`
Expected: FAIL，`Cannot find module '../src/wire-types.js'`

- [ ] **Step 3: 写 src/wire-types.ts**

字段依据实测：消息校验 `store.ts:365-381`，part 校验 `store.ts:462-471`，
part 各变体形状 `tests/helpers.mjs:138-221`。

```ts
/** Wire shapes archived by the store. Ported from @opencode-ai/sdk; the store
 *  validates exactly the fields marked required here (see store.ts:365, 462). */

export type MessageTime = { created: number; updated?: number; completed?: number };

export type Message = {
  id: string;
  sessionID: string;
  role: string;
  time: MessageTime;
  parentID?: string;
  agent?: string;
  mode?: string;
  modelID?: string;
  providerID?: string;
  model?: { providerID: string; modelID: string };
  [key: string]: unknown;
};

export type PartBase = { id: string; messageID: string; sessionID: string; type: string };

export type TextPart = PartBase & {
  type: 'text';
  text: string;
  metadata?: Record<string, unknown>;
};

export type ReasoningPart = PartBase & {
  type: 'reasoning';
  text: string;
  time?: { start: number; end?: number };
};

export type ToolState =
  | {
      status: 'completed';
      input: Record<string, unknown>;
      output: string;
      title?: string;
      metadata?: Record<string, unknown>;
      time?: { start: number; end?: number };
      attachments?: unknown[];
    }
  | {
      status: 'error';
      input: Record<string, unknown>;
      error: string;
      metadata?: Record<string, unknown>;
      time?: { start: number; end?: number };
    }
  | { status: 'pending' | 'running'; input?: Record<string, unknown> };

export type ToolPart = PartBase & {
  type: 'tool';
  callID: string;
  tool: string;
  state: ToolState;
};

export type FileSourceText = { value: string; start: number; end: number };

export type FilePart = PartBase & {
  type: 'file';
  filename?: string;
  mime?: string;
  source?: { path?: string; text?: FileSourceText };
};

export type GenericPart = PartBase & { [key: string]: unknown };

export type Part = TextPart | ReasoningPart | ToolPart | FilePart | GenericPart;

export type Event = { type: string; properties: Record<string, unknown> };

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
```

`Message` 与 `GenericPart` 带索引签名：store 把 `info_json` 整体序列化落库
（`store.ts:1248`），未知字段必须能透传。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/wire-types.test.mjs`
Expected: PASS，2 个用例。

- [ ] **Step 5: 换掉 5 个文件的导入**

把这 5 行逐一替换：

| 文件:行 | 原内容 | 新内容 |
| --- | --- | --- |
| `src/types.ts:1` | `import type { Message, Part } from '@opencode-ai/sdk';` | `import type { Message, Part } from './wire-types.js';` |
| `src/lcm-store.ts:1` | `import type { Event } from '@opencode-ai/sdk';` | `import type { Event } from './wire-types.js';` |
| `src/preview-providers.ts:4` | `import type { Part } from '@opencode-ai/sdk';` | `import type { Part } from './wire-types.js';` |
| `src/store-artifacts.ts:3` | `import type { Message, Part } from '@opencode-ai/sdk';` | `import type { Message, Part } from './wire-types.js';` |
| `src/store.ts:6` | `import type { Event, Message, Part } from '@opencode-ai/sdk';` | `import type { Event, Message, Part } from './wire-types.js';` |

- [ ] **Step 6: typecheck 并修残留错误**

Run: `bun run typecheck`
Expected: PASS。若报 part 变体字段缺失，在 `wire-types.ts` 对应变体补字段——
**不要**改 `store.ts` 的逻辑来迁就类型。

- [ ] **Step 7: 确认零 opencode 残留**

Run: `grep -rn "@opencode-ai" src/ tests/ ; echo "exit=$?"`
Expected: 无输出，`exit=1`。

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat: local wire types, drop @opencode-ai/sdk dependency"
```

---

### Task 3: ID 合成

**Files:**
- Create: `src/omp/ids.ts`
- Create: `tests/omp-ids.test.mjs`

**Interfaces:**
- Consumes: `src/utils.ts:70` 的 `hashContent(content: string): string`
- Produces:
  - `messageId(sessionID: string, message: AgentMessageLike): string`
  - `partId(messageID: string, index: number): string`
  - `type AgentMessageLike = { role: string; content: unknown; timestamp?: number }`
  Task 4/5 用这两个函数。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-ids.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { messageId, partId } from '../src/omp/ids.js';

const msg = { role: 'user', content: 'hello', timestamp: 1000 };

test('messageId is deterministic across calls and object identities', () => {
  const a = messageId('s1', msg);
  const b = messageId('s1', { role: 'user', content: 'hello', timestamp: 1000 });
  assert.equal(a, b);
  assert.match(a, /^m_[0-9a-f]{16}$/);
});

test('messageId separates by session, role, timestamp, and content', () => {
  const base = messageId('s1', msg);
  assert.notEqual(base, messageId('s2', msg));
  assert.notEqual(base, messageId('s1', { ...msg, role: 'assistant' }));
  assert.notEqual(base, messageId('s1', { ...msg, timestamp: 1001 }));
  assert.notEqual(base, messageId('s1', { ...msg, content: 'hi' }));
});

test('messageId handles array content and is order-sensitive', () => {
  const one = messageId('s1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    timestamp: 5,
  });
  const two = messageId('s1', {
    role: 'assistant',
    content: [{ type: 'text', text: 'b' }, { type: 'text', text: 'a' }],
    timestamp: 5,
  });
  assert.notEqual(one, two);
});

test('messageId tolerates a missing timestamp', () => {
  const id = messageId('s1', { role: 'user', content: 'x' });
  assert.match(id, /^m_[0-9a-f]{16}$/);
});

test('partId derives from messageID and index', () => {
  assert.equal(partId('m_abc', 0), 'm_abc_p0');
  assert.notEqual(partId('m_abc', 0), partId('m_abc', 1));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-ids.test.mjs`
Expected: FAIL，`Cannot find module '../src/omp/ids.js'`

- [ ] **Step 3: 写 src/omp/ids.ts**

```ts
import { hashContent } from '../utils.js';

export type AgentMessageLike = {
  role: string;
  content: unknown;
  timestamp?: number;
};

/** Stable digest of a message's content. Order-sensitive: reordering blocks
 *  yields a different id, because a reordered assistant turn is a different turn. */
function contentDigest(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  return content.map((block) => JSON.stringify(block)).join('\u0000');
}

/**
 * Content-addressed message id.
 *
 * A monotonic counter cannot be used: it restarts at zero when a session is
 * resumed, so the same message would archive twice under different ids. Hashing
 * (session, role, timestamp, content) is idempotent across processes, which is
 * exactly what the store's `messages.message_id` primary key needs.
 */
export function messageId(sessionID: string, message: AgentMessageLike): string {
  const parts = [
    sessionID,
    message.role,
    String(message.timestamp ?? 0),
    contentDigest(message.content),
  ];
  return `m_${hashContent(parts.join('\u0001')).slice(0, 16)}`;
}

export function partId(messageID: string, index: number): string {
  return `${messageID}_p${index}`;
}
```

`\u0001` 作字段分隔、`\u0000` 作块分隔：这两个字符不会出现在正常文本里，
避免 `"a" + "b"` 与 `"ab" + ""` 撞哈希。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/omp-ids.test.mjs`
Expected: PASS，5 个用例。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: content-addressed message id synthesis"
```

---

### Task 4: 消息适配器（双向）

**Files:**
- Create: `src/omp/adapter-messages.ts`
- Create: `tests/omp-adapter-messages.test.mjs`

**Interfaces:**
- Consumes: `src/omp/ids.ts` 的 `messageId`/`partId`；`src/wire-types.ts` 的 `Message`/`Part`；`src/types.ts` 的 `ConversationMessage`
- Produces:
  - `toConversationMessage(sessionID: string, message: unknown): ConversationMessage | undefined`
  - `toConversationMessages(sessionID: string, messages: unknown[]): ConversationMessage[]`
  - `applyRecalledContent(original: unknown[], conv: ConversationMessage[]): unknown[]`
  Task 5 用前两个归档，Task 6 用第三个回写召回结果。

**背景（实现者必读）:** omp 的消息是扁平 `{ role, content[], timestamp }`，**没有 id**。
opencode 的 store 要 `{ info: Message; parts: Part[] }` 且 `info` 必须过
`store.ts:365-381` 的四项校验。`role` 取值差异：omp 有 `user`/`developer`/`assistant`/`toolResult`
（`pi-ai/src/types.ts:964`），opencode 侧 `role` 是自由字符串，直接沿用即可。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-adapter-messages.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidWireMessage, isValidWirePart } from '../src/wire-types.js';
import {
  applyRecalledContent,
  toConversationMessage,
  toConversationMessages,
} from '../src/omp/adapter-messages.js';

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

test('assistant blocks map to text, reasoning, and tool parts', () => {
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
  assert.deepEqual(toConversationMessages('s1', [null, userMsg]).length, 1);
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

  const [result] = applyRecalledContent(originals, conv);
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
  const result = applyRecalledContent(originals, []);
  assert.deepEqual(result, originals);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-adapter-messages.test.mjs`
Expected: FAIL，`Cannot find module '../src/omp/adapter-messages.js'`

- [ ] **Step 3: 写 src/omp/adapter-messages.ts**

```ts
import type { ConversationMessage } from '../types.js';
import type { Message, Part, ToolPart, ToolState } from '../wire-types.js';
import { type AgentMessageLike, messageId, partId } from './ids.js';

/** Provider fields that must survive a recall round trip: dropping them breaks
 *  transport-native replay (see pi-ai/src/types.ts:892-940). */
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
  'toolCallId',
  'toolName',
  'isError',
  'details',
] as const;

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

function toPart(
  sessionID: string,
  messageID: string,
  index: number,
  block: Block,
): Part | undefined {
  const base = { id: partId(messageID, index), messageID, sessionID };
  switch (block.type) {
    case 'text':
      return { ...base, type: 'text', text: String(block.text ?? '') };
    case 'thinking':
      return { ...base, type: 'reasoning', text: String(block.thinking ?? '') };
    case 'toolCall': {
      const callID = typeof block.id === 'string' ? block.id : base.id;
      return {
        ...base,
        type: 'tool',
        callID,
        tool: String(block.name ?? 'unknown'),
        state: { status: 'pending', input: (asRecord(block.arguments) ?? {}) as Record<string, unknown> },
      };
    }
    case 'image':
      return {
        ...base,
        type: 'file',
        mime: typeof block.mimeType === 'string' ? block.mimeType : 'application/octet-stream',
      };
    default:
      // Unknown block kinds (redactedThinking, anthropic server tools, ...) are
      // archived opaquely rather than dropped: the store serializes them as-is.
      return { ...base, type: String(block.type ?? 'unknown'), raw: block };
  }
}

/** Map one omp message. Returns undefined when the shape cannot satisfy the
 *  store's validation (store.ts:365-381), so callers skip instead of poisoning. */
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
  const created = like.timestamp ?? Date.now();

  const info: Message = {
    id,
    sessionID,
    role: record.role,
    time: { created },
  };
  for (const key of ['api', 'provider', 'model', 'usage', 'stopReason'] as const) {
    if (record[key] !== undefined) info[key] = record[key];
  }

  const parts: Part[] = [];
  blocksOf(record.content).forEach((block, index) => {
    const part = toPart(sessionID, id, index, block);
    if (part) parts.push(part);
  });

  return { info, parts };
}

/** Merge a toolResult into the tool part of the assistant turn that issued the
 *  call. opencode models a tool call and its result as ONE part; omp splits them
 *  into two messages, so the result has to be folded back in. */
function mergeToolResult(conv: ConversationMessage[], record: Record<string, unknown>): boolean {
  const callId = record.toolCallId;
  if (typeof callId !== 'string') return false;

  for (let i = conv.length - 1; i >= 0; i--) {
    const target = conv[i].parts.find(
      (part): part is ToolPart => part.type === 'tool' && part.callID === callId,
    );
    if (!target) continue;

    const text = textOfBlocks(blocksOf(record.content));
    const input = (target.state as { input?: Record<string, unknown> }).input ?? {};
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
        blocks.push({ type: 'text', text: (part as { text?: string }).text ?? '' });
        break;
      case 'reasoning':
        blocks.push({ type: 'thinking', thinking: (part as { text?: string }).text ?? '' });
        break;
      case 'tool': {
        const tool = part as ToolPart;
        blocks.push({
          type: 'toolCall',
          id: tool.callID,
          name: tool.tool,
          arguments: (tool.state as { input?: Record<string, unknown> }).input ?? {},
        });
        break;
      }
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
 * The original message is the template: only `content` is replaced. Every
 * provider field is copied verbatim, and messages the store dropped (or that
 * never mapped) pass through untouched.
 */
export function applyRecalledContent(original: unknown[], conv: ConversationMessage[]): unknown[] {
  if (conv.length === 0) return original;

  const byId = new Map(conv.map((entry) => [entry.info.id, entry]));
  const result: unknown[] = [];

  for (const message of original) {
    const record = asRecord(message);
    if (!record || typeof record.role !== 'string') {
      result.push(message);
      continue;
    }
    const id = messageId(String(conv[0]?.info.sessionID ?? ''), {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/omp-adapter-messages.test.mjs`
Expected: PASS，9 个用例。

- [ ] **Step 5: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: bidirectional omp/opencode message adapter"
```

---

### Task 5: 事件适配器

**Files:**
- Create: `src/omp/adapter-events.ts`
- Create: `tests/omp-adapter-events.test.mjs`

**Interfaces:**
- Consumes: `src/omp/adapter-messages.ts` 的 `toConversationMessages`；`src/wire-types.ts` 的 `Event`
- Produces:
  - `sessionEvent(type, input): Event` —— `type` 为 `'created' | 'updated' | 'deleted' | 'compacted'`，`input: { sessionID, title?, directory?, parentSessionID? }`
  - `messageEvents(sessionID: string, messages: unknown[]): Event[]`
  - `parseParentSession(raw: string | undefined): string | undefined`
  Task 7 的扩展入口用这三个。

**背景（实现者必读）:** `SessionSwitchEvent` 只带 `reason`（`shared-events.ts:42-45`），
`SessionBranchEvent` 只带 `previousSessionFile`（`:58-61`）——**都不带 session 标识**。
父会话只能从 `ctx.sessionManager.getHeader().parentSession` 取，而该字段是 opaque 串：
可能是 session id，也可能是 `.jsonl` 路径（`session.md` 头部明确说「Treat it as
metadata, not a typed foreign key」）。所以要先判别形态。

omp 会话文件名格式 `<timestamp>_<sessionId>.jsonl`（`session.md` On-Disk Layout）。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-adapter-events.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { messageEvents, parseParentSession, sessionEvent } from '../src/omp/adapter-events.js';

test('parseParentSession accepts a bare session id', () => {
  assert.equal(parseParentSession('01a01ac1-18a2-7000-a7bc-3ca092a6a14e'), '01a01ac1-18a2-7000-a7bc-3ca092a6a14e');
});

test('parseParentSession extracts the id from a session file path', () => {
  const p = '/root/.omp/agent/sessions/-work/2026-08-19T16-00-57-506Z_01a01ac1-18a2-7000-a7bc-3ca092a6a14e.jsonl';
  assert.equal(parseParentSession(p), '01a01ac1-18a2-7000-a7bc-3ca092a6a14e');
});

test('parseParentSession returns undefined for unusable input', () => {
  assert.equal(parseParentSession(undefined), undefined);
  assert.equal(parseParentSession(''), undefined);
  assert.equal(parseParentSession('   '), undefined);
});

test('sessionEvent emits the opencode event shape the store dispatches on', () => {
  const event = sessionEvent('created', {
    sessionID: 's1',
    title: 'my session',
    directory: '/work',
    parentSessionID: 'root1',
  });
  assert.equal(event.type, 'session.created');
  assert.equal(event.properties.info.id, 's1');
  assert.equal(event.properties.info.title, 'my session');
  assert.equal(event.properties.info.directory, '/work');
  assert.equal(event.properties.info.parentID, 'root1');
  assert.equal(typeof event.properties.info.time.created, 'number');
});

test('sessionEvent maps every supported kind', () => {
  for (const [kind, expected] of [
    ['created', 'session.created'],
    ['updated', 'session.updated'],
    ['deleted', 'session.deleted'],
    ['compacted', 'session.compacted'],
  ]) {
    assert.equal(sessionEvent(kind, { sessionID: 's1' }).type, expected);
  }
});

test('messageEvents emits one message.updated plus one part event per part', () => {
  const events = messageEvents('s1', [
    { role: 'user', content: 'hello', timestamp: 1000 },
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'message.updated');
  assert.equal(events[0].properties.info.sessionID, 's1');
  assert.equal(events[1].type, 'message.part.updated');
  assert.equal(events[1].properties.part.messageID, events[0].properties.info.id);
  assert.equal(events[1].properties.part.type, 'text');
});

test('messageEvents orders message.updated before its parts', () => {
  const events = messageEvents('s1', [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'a' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: {} },
      ],
      timestamp: 2000,
    },
  ]);
  assert.deepEqual(
    events.map((e) => e.type),
    ['message.updated', 'message.part.updated', 'message.part.updated'],
  );
});

test('messageEvents skips unmappable messages without throwing', () => {
  assert.deepEqual(messageEvents('s1', [null, undefined, { content: 'no role' }]), []);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-adapter-events.test.mjs`
Expected: FAIL，`Cannot find module '../src/omp/adapter-events.js'`

- [ ] **Step 3: 写 src/omp/adapter-events.ts**

```ts
import path from 'node:path';

import type { Event } from '../wire-types.js';
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
 * The field is an opaque lineage string: current omp code writes either a
 * session id or a session file path depending on the flow (session.md warns it
 * is "metadata, not a typed foreign key"). Session files are named
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
  return {
    type: `session.${kind}`,
    properties: {
      info: {
        id: input.sessionID,
        title: input.title,
        directory: input.directory,
        parentID: input.parentSessionID,
        time: { created: now, updated: now },
      },
    },
  };
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/omp-adapter-events.test.mjs`
Expected: PASS，8 个用例。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: omp lifecycle events to opencode capture events"
```

---

### Task 6: 配置层

**Files:**
- Create: `src/omp/config.ts`
- Create: `tests/omp-config.test.mjs`
- Modify: `src/options.ts`（改环境变量前缀与去 sidecar 字段）

**Interfaces:**
- Consumes: `src/options.ts` 的 `resolveOptions(raw: unknown)` 与 `DEFAULT_OPTIONS`
- Produces: `loadOptions(cwd: string, agentDir?: string): OpencodeLcmOptions`
  Task 7 的扩展入口用它。

**背景（实现者必读）:** omp 没有 opencode 的 `plugin: [["name", {opts}]]` 传参机制。
`Settings.get()` 的键受 schema 约束（`SettingPath = keyof Schema`，
`settings-schema.ts:5590`），任意 `lcm.*` 不是合法路径，所以必须自带配置文件。

`resolveOptions` 原样复用做归一化与容错——它已被源仓库测试覆盖畸形输入。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-config.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadOptions } from '../src/omp/config.js';

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-config.test.mjs`
Expected: FAIL，`Cannot find module '../src/omp/config.js'`

- [ ] **Step 3: 写 src/omp/config.ts**

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { resolveOptions } from '../options.js';
import type { OpencodeLcmOptions } from '../types.js';

function readJsonObject(file: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    // Missing or malformed config must never block session startup.
    return undefined;
  }
}

function mergeDeep(
  base: Record<string, unknown>,
  overlay: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = result[key];
    const bothPlainObjects =
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing);
    result[key] = bothPlainObjects
      ? mergeDeep(existing as Record<string, unknown>, value as Record<string, unknown>)
      : value;
  }
  return result;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : undefined;
}

function envBool(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '') return undefined;
  if (raw === '0' || raw === 'false' || raw === 'no') return false;
  return true;
}

function envOverlay(): Record<string, unknown> {
  const overlay: Record<string, unknown> = {};

  const freshTail = envInt('OMP_LCM_FRESH_TAIL_MESSAGES');
  if (freshTail !== undefined) overlay.freshTailMessages = freshTail;

  const minMessages = envInt('OMP_LCM_MIN_MESSAGES_FOR_TRANSFORM');
  if (minMessages !== undefined) overlay.minMessagesForTransform = minMessages;

  const summaryBudget = envInt('OMP_LCM_SUMMARY_CHAR_BUDGET');
  if (summaryBudget !== undefined) overlay.summaryCharBudget = summaryBudget;

  const retrieval = envBool('OMP_LCM_AUTOMATIC_RETRIEVAL');
  if (retrieval !== undefined) overlay.automaticRetrieval = { enabled: retrieval };

  const systemHint = envBool('OMP_LCM_SYSTEM_HINT');
  if (systemHint !== undefined) overlay.systemHint = systemHint;

  return overlay;
}

/**
 * Load options for a session.
 *
 * omp has no per-extension config channel (SettingPath is closed over a fixed
 * schema, settings-schema.ts:5590), so configuration is layered by hand:
 * built-in defaults, then user config, then project config, then env.
 * `resolveOptions` performs all normalization and clamping.
 */
export function loadOptions(cwd: string, agentDir?: string): OpencodeLcmOptions {
  const userDir = agentDir ?? path.join(homedir(), '.omp', 'agent');
  const layers = [
    readJsonObject(path.join(userDir, 'lcm.json')),
    readJsonObject(path.join(cwd, '.omp', 'lcm.json')),
    envOverlay(),
  ];

  let raw: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer) raw = mergeDeep(raw, layer);
  }

  return resolveOptions(raw);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/omp-config.test.mjs`
Expected: PASS，6 个用例。

- [ ] **Step 5: 改 src/options.ts 的环境变量与 sidecar 残留**

把 `src/options.ts` 里所有 `OPENCODE_LCM_` 前缀改为 `OMP_LCM_`，
并删除 `runtimeSafety` / `allowUnsafeBunWindows` 相关字段与其默认值
（`DEFAULT_RUNTIME_SAFETY`，`src/options.ts:65-67`）。同步删 `src/types.ts` 的
`RuntimeSafetyOptions`（`src/types.ts:65-68`）与 `OpencodeLcmOptions` 里的引用。

Run: `grep -rn "OPENCODE_LCM_\|allowUnsafeBunWindows\|RuntimeSafety" src/ ; echo "exit=$?"`
Expected: 无输出，`exit=1`。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS。若 `store.ts` 引用了已删的 `runtimeSafety`，一并删掉那些分支——
它们都是 Bun-on-Windows 专用（spec §4.7）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: layered config loading, drop sidecar options"
```

---

### Task 7: 扩展入口（事件接线 + 召回 + compaction）

**Files:**
- Create: `src/omp/extension.ts`
- Create: `tests/omp-extension.test.mjs`

**Interfaces:**
- Consumes: `src/omp/config.ts` 的 `loadOptions`；`src/omp/adapter-events.ts` 的
  `sessionEvent`/`messageEvents`/`parseParentSession`；`src/omp/adapter-messages.ts` 的
  `toConversationMessages`/`applyRecalledContent`；`src/store.ts` 的 `SqliteLcmStore`；
  `src/omp/tools.ts` 的 `registerLcmTools`（Task 8 提供，本 task 先按接口调用）
- Produces: 默认导出 `(pi: ExtensionAPI) => void`；具名导出
  `createRuntime(deps): LcmRuntime` 供测试注入，`LcmRuntime` 含
  `onSessionStart`/`onMessageEnd`/`onContext`/`onCompacting`/`onShutdown`。

**背景（实现者必读）:**

- `context` 事件给的是**深拷贝**（`shared-events.ts:181`），原地改写无效，
  必须 `return { messages }`（`extensions/types.ts:1068-1070`）。
- `session.compacting` 返回 `{ context?: string[] }`（`shared-events.ts:384-387`）。
- 扩展**不沙箱**：handler 里未捕获的抛出会经扩展错误通道上报；
  裸 `setInterval` 抛出会 process-fatal 拖垮会话，所以后台任务必须用
  `ctx.setInterval`（`extensions/types.ts:489`）。
- 注册期不能调运行时动作方法（`extension-loading.md`），所以 store 的创建与
  `init()` 都放到 `session_start` 里做。

把业务逻辑放进 `createRuntime`（纯函数依赖注入），`extension.ts` 的默认导出只做接线。
这样测试无需伪造整个 `ExtensionAPI`。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-extension.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRuntime } from '../src/omp/extension.js';

function makeStore(overrides = {}) {
  const calls = { captured: [], transformed: 0, closed: 0 };
  return {
    calls,
    async init() {},
    async close() {
      calls.closed += 1;
    },
    async captureDeferred(event) {
      calls.captured.push(event);
    },
    async transformMessages() {
      calls.transformed += 1;
      return false;
    },
    async buildCompactionContext() {
      return undefined;
    },
    systemHint() {
      return undefined;
    },
    ...overrides,
  };
}

function makeCtx(sessionID = 's1', header = {}) {
  return {
    cwd: '/work',
    sessionManager: {
      getSessionId: () => sessionID,
      getHeader: () => ({ title: 'T', ...header }),
    },
  };
}

test('session_start initializes the store and captures session.created', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  assert.equal(store.calls.captured[0].type, 'session.created');
  assert.equal(store.calls.captured[0].properties.info.id, 's1');
  assert.equal(store.calls.captured[0].properties.info.directory, '/work');
});

test('session_start resolves parentSession from the header', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(
    makeCtx('s2', {
      parentSession: '/root/.omp/agent/sessions/-w/2026-08-19T00-00-00-000Z_parent99.jsonl',
    }),
  );
  assert.equal(store.calls.captured[0].properties.info.parentID, 'parent99');
});

test('message_end archives one message.updated plus its parts', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  store.calls.captured.length = 0;

  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'hi', timestamp: 1 });
  assert.deepEqual(
    store.calls.captured.map((e) => e.type),
    ['message.updated', 'message.part.updated'],
  );
});

test('context returns undefined when the store made no change', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  const messages = [{ role: 'user', content: 'q', timestamp: 1 }];
  assert.equal(await runtime.onContext(makeCtx(), messages), undefined);
  assert.equal(store.calls.transformed, 1);
});

test('context returns replaced messages when the store injected recall', async () => {
  const store = makeStore({
    async transformMessages(conv) {
      conv[0].parts.push({
        id: 'synthetic',
        messageID: conv[0].info.id,
        sessionID: conv[0].info.sessionID,
        type: 'text',
        text: '[recalled] db.ts',
      });
      return true;
    },
  });
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());

  const messages = [{ role: 'user', content: 'q', timestamp: 1 }];
  const result = await runtime.onContext(makeCtx(), messages);
  assert.ok(result);
  const texts = result.messages[0].content.map((b) => b.text);
  assert.ok(texts.some((t) => t.includes('[recalled] db.ts')));
});

test('context prepends the system hint as a developer message', async () => {
  const store = makeStore({
    systemHint: () => 'Archived state may exist.',
    async transformMessages() {
      return true;
    },
  });
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());

  const result = await runtime.onContext(makeCtx(), [{ role: 'user', content: 'q', timestamp: 1 }]);
  assert.equal(result.messages[0].role, 'developer');
  assert.equal(result.messages[0].content, 'Archived state may exist.');
  assert.equal(typeof result.messages[0].timestamp, 'number');
});

test('session.compacting returns the resume note as context', async () => {
  const store = makeStore({
    async buildCompactionContext() {
      return 'LCM resume note body';
    },
  });
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  assert.deepEqual(await runtime.onCompacting(makeCtx(), 's1'), {
    context: ['LCM resume note body'],
  });
});

test('session.compacting returns undefined when there is no note', async () => {
  const runtime = createRuntime({ store: makeStore(), logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  assert.equal(await runtime.onCompacting(makeCtx(), 's1'), undefined);
});

test('a throwing store never propagates out of a handler', async () => {
  const warnings = [];
  const store = makeStore({
    async captureDeferred() {
      throw new Error('disk on fire');
    },
    async transformMessages() {
      throw new Error('disk on fire');
    },
  });
  const runtime = createRuntime({ store, logger: { warn: (m) => warnings.push(m) } });

  await runtime.onSessionStart(makeCtx());
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(await runtime.onContext(makeCtx(), [{ role: 'user', content: 'x', timestamp: 1 }]), undefined);
  assert.ok(warnings.length >= 2, 'failures are logged, not thrown');
});

test('handlers before session_start are inert', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(store.calls.captured.length, 0);
});

test('shutdown closes the store once', async () => {
  const store = makeStore();
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  await runtime.onShutdown();
  await runtime.onShutdown();
  assert.equal(store.calls.closed, 1);
});

test('a failed init degrades to no-op instead of throwing', async () => {
  const store = makeStore({
    async init() {
      throw new Error('schema too new');
    },
  });
  const runtime = createRuntime({ store, logger: { warn() {} } });
  await runtime.onSessionStart(makeCtx());
  assert.equal(runtime.isDegraded(), true);
  await runtime.onMessageEnd(makeCtx(), { role: 'user', content: 'x', timestamp: 1 });
  assert.equal(store.calls.captured.length, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-extension.test.mjs`
Expected: FAIL，`Cannot find module '../src/omp/extension.js'`

- [ ] **Step 3: 写 src/omp/extension.ts**

```ts
import type { LcmStore } from '../lcm-store.js';
import { SqliteLcmStore } from '../store.js';
import { messageEvents, parseParentSession, sessionEvent } from './adapter-events.js';
import { applyRecalledContent, toConversationMessages } from './adapter-messages.js';
import { loadOptions } from './config.js';
import { registerLcmTools } from './tools.js';

type Warner = { warn(message: string, detail?: unknown): void };

type SessionCtx = {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getHeader(): { title?: string; parentSession?: string } | undefined;
  };
};

export type LcmRuntime = {
  onSessionStart(ctx: SessionCtx): Promise<void>;
  onSessionUpdate(ctx: SessionCtx, kind: 'updated' | 'compacted'): Promise<void>;
  onMessageEnd(ctx: SessionCtx, message: unknown): Promise<void>;
  onContext(ctx: SessionCtx, messages: unknown[]): Promise<{ messages: unknown[] } | undefined>;
  onCompacting(ctx: SessionCtx, sessionId: string): Promise<{ context: string[] } | undefined>;
  onShutdown(): Promise<void>;
  isDegraded(): boolean;
  store(): LcmStore;
};

/**
 * Extension logic with injected dependencies.
 *
 * Every handler is fail-soft: archiving is a side channel, so a store failure
 * must degrade recall rather than break the session. Extensions run unsandboxed
 * in-process, so an escaping throw would surface as a session-level error.
 */
export function createRuntime(deps: { store: LcmStore; logger: Warner }): LcmRuntime {
  const { store, logger } = deps;
  let started = false;
  let degraded = false;
  let closed = false;

  const sessionOf = (ctx: SessionCtx) => ctx.sessionManager.getSessionId();
  const active = () => started && !degraded && !closed;

  async function guard(operation: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logger.warn(`omp-lcm ${operation} failed`, error);
    }
  }

  return {
    async onSessionStart(ctx) {
      if (started) return;
      started = true;
      try {
        await store.init();
      } catch (error) {
        degraded = true;
        logger.warn('omp-lcm disabled: store init failed', error);
        return;
      }

      const header = ctx.sessionManager.getHeader();
      await guard('session.created capture', async () => {
        await store.captureDeferred(
          sessionEvent('created', {
            sessionID: sessionOf(ctx),
            title: header?.title,
            directory: ctx.cwd,
            parentSessionID: parseParentSession(header?.parentSession),
          }),
        );
      });
    },

    async onSessionUpdate(ctx, kind) {
      if (!active()) return;
      const header = ctx.sessionManager.getHeader();
      await guard(`session.${kind} capture`, async () => {
        await store.captureDeferred(
          sessionEvent(kind, {
            sessionID: sessionOf(ctx),
            title: header?.title,
            directory: ctx.cwd,
            parentSessionID: parseParentSession(header?.parentSession),
          }),
        );
      });
    },

    async onMessageEnd(ctx, message) {
      if (!active()) return;
      await guard('message capture', async () => {
        for (const event of messageEvents(sessionOf(ctx), [message])) {
          await store.captureDeferred(event);
        }
      });
    },

    async onContext(ctx, messages) {
      if (!active()) return undefined;

      try {
        const sessionID = sessionOf(ctx);
        const conv = toConversationMessages(sessionID, messages);
        const changed = await store.transformMessages(conv);
        if (!changed) return undefined;

        // `changed === false` strictly means "untouched": every early return in
        // transformMessages leaves the array alone, and its splice path is
        // unreachable for this operation (store.ts:387).
        const rewritten = applyRecalledContent(messages, conv);
        const hint = store.systemHint();
        if (!hint) return { messages: rewritten };

        return {
          messages: [
            { role: 'developer', content: hint, timestamp: Date.now() },
            ...rewritten,
          ],
        };
      } catch (error) {
        logger.warn('omp-lcm recall failed', error);
        return undefined;
      }
    },

    async onCompacting(_ctx, sessionId) {
      if (!active()) return undefined;
      try {
        const note = await store.buildCompactionContext(sessionId);
        return note ? { context: [note] } : undefined;
      } catch (error) {
        logger.warn('omp-lcm compaction context failed', error);
        return undefined;
      }
    },

    async onShutdown() {
      if (closed || !started) return;
      closed = true;
      await guard('store close', async () => {
        await store.close();
      });
    },

    isDegraded() {
      return degraded;
    },

    store() {
      return store;
    },
  };
}

// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI is host-provided.
type ExtensionAPI = any;

export default function ompLcm(pi: ExtensionAPI): void {
  let runtime: LcmRuntime | undefined;

  pi.setLabel?.('LCM (lossless context memory)');

  // The store is constructed on first session_start, not at load time: runtime
  // action methods are unavailable during extension load, and cwd is only known
  // from the handler context.
  const ensure = (ctx: SessionCtx): LcmRuntime => {
    if (!runtime) {
      const options = loadOptions(ctx.cwd);
      runtime = createRuntime({
        store: new SqliteLcmStore(ctx.cwd, options),
        logger: pi.logger,
      });
    }
    return runtime;
  };

  pi.on('session_start', async (_event: unknown, ctx: SessionCtx) => {
    await ensure(ctx).onSessionStart(ctx);
  });

  pi.on('session_switch', async (_event: unknown, ctx: SessionCtx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'updated');
  });

  pi.on('session_branch', async (_event: unknown, ctx: SessionCtx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'updated');
  });

  pi.on('session_compact', async (_event: unknown, ctx: SessionCtx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'compacted');
  });

  pi.on('message_end', async (event: { message: unknown }, ctx: SessionCtx) => {
    await ensure(ctx).onMessageEnd(ctx, event.message);
  });

  pi.on('context', async (event: { messages: unknown[] }, ctx: SessionCtx) => {
    return await ensure(ctx).onContext(ctx, event.messages);
  });

  pi.on('session.compacting', async (event: { sessionId: string }, ctx: SessionCtx) => {
    return await ensure(ctx).onCompacting(ctx, event.sessionId);
  });

  pi.on('session_shutdown', async () => {
    await runtime?.onShutdown();
  });

  registerLcmTools(pi, () => runtime);
}
```

`ExtensionAPI` 用 `any` 别名：宿主类型来自 `@oh-my-pi/pi-coding-agent`，
把它列为依赖会让扩展包绑死宿主版本。宿主 API 面很小（`on`/`registerTool`/
`logger`/`setLabel`/`zod`），运行时行为由 Task 9 的真机烟测把关。

- [ ] **Step 4: 先建 tools.ts 存根让测试能跑**

Task 8 会写真正内容。此刻只需让导入成立：

```ts
// src/omp/tools.ts
// biome-ignore lint/suspicious/noExplicitAny: ExtensionAPI is host-provided.
export function registerLcmTools(_pi: any, _runtime: () => unknown): void {}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test tests/omp-extension.test.mjs`
Expected: PASS，12 个用例。

- [ ] **Step 6: typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat: omp extension entry with archive, recall, and compaction wiring"
```

---

### Task 8: 18 个工具注册

**Files:**
- Modify: `src/omp/tools.ts`（Task 7 建的存根，本 task 写完整实现）
- Create: `tests/omp-tools.test.mjs`

**Interfaces:**
- Consumes: `src/omp/extension.ts` 的 `LcmRuntime`（经 `() => LcmRuntime | undefined` 取）
- Produces: `registerLcmTools(pi, getRuntime): void`；具名导出
  `LCM_TOOL_SPECS: ToolSpec[]` 供测试枚举，`ToolSpec` 含
  `{ name, description, params(z), run(store, args, ctx) }`。

**背景（实现者必读）:** 三处签名差异，逐条对齐：

| 维度 | opencode | omp |
| --- | --- | --- |
| schema | `args: { x: tool.schema.string() }`（zod 4.1.8） | `parameters: z.object({...})`，`z = pi.zod`（`extensions/types.ts:585, 1186`） |
| execute | `(args, context) => string` | `(toolCallId, params, signal, onUpdate, ctx) => AgentToolResult`（`extensions/types.ts:606-612`） |
| 返回值 | 裸 `string` | `{ content: [{ type: 'text', text }], details? }` |
| 必填字段 | 只有 `description` | 还要 `label`（`extensions/types.ts:581`） |

`sessionID` 兜底：opencode 侧 `lcm_retrieval_debug` 用 `context.sessionID`
（`src/index.ts:203-204`）；omp 侧改用 `ctx.sessionManager.getSessionId()`。

`approval` 标记：读类工具标 `'read'`，写类（`lcm_pin_session`、`lcm_unpin_session`、
`lcm_blob_gc`、`lcm_compact`、`lcm_doctor`、`lcm_retention_prune`、
`lcm_import_snapshot`、`lcm_export_snapshot`）标 `'write'`。缺省是 `'exec'`
（`extensions/types.ts:595-597`），对纯查询过严。

源定义逐一在 `src/index.ts`：`lcm_status:121`、`lcm_retrieval_debug:198`、
`lcm_resume:208`、`lcm_grep:218`、`lcm_describe:244`、`lcm_lineage:258`、
`lcm_pin_session:268`、`lcm_unpin_session:282`、`lcm_expand:294`、`lcm_artifact:316`、
`lcm_blob_stats:330`、`lcm_blob_gc:342`、`lcm_compact:356`、`lcm_doctor:373`、
`lcm_retention_report:389`、`lcm_retention_prune:407`、`lcm_export_snapshot:427`、
`lcm_import_snapshot:443`。参数上下界必须逐字照搬。

- [ ] **Step 1: 写失败测试**

```js
// tests/omp-tools.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { LCM_TOOL_SPECS, registerLcmTools } from '../src/omp/tools.js';

const EXPECTED = [
  'lcm_status', 'lcm_retrieval_debug', 'lcm_resume', 'lcm_grep', 'lcm_describe',
  'lcm_lineage', 'lcm_pin_session', 'lcm_unpin_session', 'lcm_expand', 'lcm_artifact',
  'lcm_blob_stats', 'lcm_blob_gc', 'lcm_compact', 'lcm_doctor', 'lcm_retention_report',
  'lcm_retention_prune', 'lcm_export_snapshot', 'lcm_import_snapshot',
];

function makePi() {
  const registered = [];
  const chain = () => {
    const node = {
      optional: () => node, min: () => node, max: () => node,
      int: () => node, describe: () => node, default: () => node,
    };
    return node;
  };
  return {
    registered,
    logger: { warn() {} },
    zod: { object: (shape) => ({ shape }), string: chain, number: chain, boolean: chain },
    registerTool(def) {
      registered.push(def);
    },
  };
}

test('all 18 tools are specified', () => {
  assert.deepEqual(LCM_TOOL_SPECS.map((s) => s.name), EXPECTED);
});

test('registerLcmTools registers every spec with required omp fields', () => {
  const pi = makePi();
  registerLcmTools(pi, () => undefined);
  assert.equal(pi.registered.length, 18);
  for (const def of pi.registered) {
    assert.equal(typeof def.name, 'string');
    assert.ok(def.label, `${def.name} needs a label`);
    assert.ok(def.description, `${def.name} needs a description`);
    assert.ok(def.parameters, `${def.name} needs parameters`);
    assert.equal(typeof def.execute, 'function');
    assert.ok(['read', 'write'].includes(def.approval), `${def.name} approval tier`);
  }
});

test('a tool returns AgentToolResult content, not a bare string', async () => {
  const pi = makePi();
  const runtime = {
    isDegraded: () => false,
    store: () => ({ async resume() { return 'note body'; } }),
  };
  registerLcmTools(pi, () => runtime);

  const def = pi.registered.find((d) => d.name === 'lcm_resume');
  const result = await def.execute('call1', {}, undefined, undefined, {
    sessionManager: { getSessionId: () => 's1' },
  });
  assert.deepEqual(result.content, [{ type: 'text', text: 'note body' }]);
  assert.ok(!result.isError);
});

test('sessionID falls back to the active session', async () => {
  const pi = makePi();
  const seen = [];
  const runtime = {
    isDegraded: () => false,
    store: () => ({
      async automaticRetrievalDebug(id) {
        seen.push(id);
        return 'debug';
      },
    }),
  };
  registerLcmTools(pi, () => runtime);

  const def = pi.registered.find((d) => d.name === 'lcm_retrieval_debug');
  await def.execute('c', {}, undefined, undefined, {
    sessionManager: { getSessionId: () => 'active1' },
  });
  assert.deepEqual(seen, ['active1']);

  await def.execute('c', { sessionID: 'explicit1' }, undefined, undefined, {
    sessionManager: { getSessionId: () => 'active1' },
  });
  assert.deepEqual(seen, ['active1', 'explicit1']);
});

test('a degraded runtime reports an error result instead of throwing', async () => {
  const pi = makePi();
  registerLcmTools(pi, () => ({ isDegraded: () => true, store: () => ({}) }));

  const def = pi.registered.find((d) => d.name === 'lcm_grep');
  const result = await def.execute('c', { query: 'x' }, undefined, undefined, {
    sessionManager: { getSessionId: () => 's1' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /unavailable/i);
});

test('an uninitialized runtime reports an error result', async () => {
  const pi = makePi();
  registerLcmTools(pi, () => undefined);
  const def = pi.registered.find((d) => d.name === 'lcm_status');
  const result = await def.execute('c', {}, undefined, undefined, {
    sessionManager: { getSessionId: () => 's1' },
  });
  assert.equal(result.isError, true);
});

test('a throwing store surfaces as an error result', async () => {
  const pi = makePi();
  registerLcmTools(pi, () => ({
    isDegraded: () => false,
    store: () => ({ async lineage() { throw new Error('db gone'); } }),
  }));
  const def = pi.registered.find((d) => d.name === 'lcm_lineage');
  const result = await def.execute('c', {}, undefined, undefined, {
    sessionManager: { getSessionId: () => 's1' },
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /db gone/);
});

test('lcm_grep formats results and reports an empty search', async () => {
  const pi = makePi();
  let results = [];
  registerLcmTools(pi, () => ({
    isDegraded: () => false,
    store: () => ({ async grep() { return results; } }),
  }));
  const def = pi.registered.find((d) => d.name === 'lcm_grep');
  const ctx = { sessionManager: { getSessionId: () => 's1' } };

  const empty = await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  assert.match(empty.content[0].text, /No archived matches/);

  results = [{ type: 'message', sessionID: 's1', snippet: 'tenant mapping' }];
  const hit = await def.execute('c', { query: 'x' }, undefined, undefined, ctx);
  assert.match(hit.content[0].text, /\[message\] session=s1 tenant mapping/);
});

test('lcm_import_snapshot normalizes mode and worktreeMode', async () => {
  const pi = makePi();
  const calls = [];
  registerLcmTools(pi, () => ({
    isDegraded: () => false,
    store: () => ({
      async importSnapshot(input) {
        calls.push(input);
        return 'ok';
      },
    }),
  }));
  const def = pi.registered.find((d) => d.name === 'lcm_import_snapshot');
  const ctx = { sessionManager: { getSessionId: () => 's1' } };

  await def.execute('c', { filePath: 'a.json' }, undefined, undefined, ctx);
  assert.equal(calls[0].mode, 'replace', 'anything but merge is replace');
  assert.equal(calls[0].worktreeMode, 'auto');

  await def.execute('c', { filePath: 'a.json', mode: 'merge', worktreeMode: 'preserve' }, undefined, undefined, ctx);
  assert.equal(calls[1].mode, 'merge');
  assert.equal(calls[1].worktreeMode, 'preserve');

  await def.execute('c', { filePath: 'a.json', worktreeMode: 'nonsense' }, undefined, undefined, ctx);
  assert.equal(calls[2].worktreeMode, 'auto');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/omp-tools.test.mjs`
Expected: FAIL，`LCM_TOOL_SPECS` 未导出（Task 7 的存根只有 `registerLcmTools`）。

- [ ] **Step 3: 写 src/omp/tools.ts**

```ts
import type { LcmStore } from '../lcm-store.js';
import type { SearchResult } from '../types.js';

// biome-ignore lint/suspicious/noExplicitAny: host-provided schema builder and API.
type Any = any;

type ToolCtx = { sessionManager: { getSessionId(): string } };

type RuntimeLike = { isDegraded(): boolean; store(): LcmStore };

export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  approval: 'read' | 'write';
  params(z: Any): Any;
  run(store: LcmStore, args: Any, ctx: ToolCtx): Promise<string>;
};

const session = (args: { sessionID?: string }, ctx: ToolCtx): string =>
  args.sessionID ?? ctx.sessionManager.getSessionId();

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No archived matches found.';
  return results
    .map((result) => {
      const suffix = result.sessionID ? ` session=${result.sessionID}` : '';
      return `[${result.type}]${suffix} ${result.snippet}`;
    })
    .join('\n\n');
}

/** Ported verbatim from src/index.ts:121-460. Bounds must match the originals. */
export const LCM_TOOL_SPECS: ToolSpec[] = [
  {
    name: 'lcm_status',
    label: 'LCM Status',
    description: 'Show archived LCM capture stats',
    approval: 'read',
    params: (z) => z.object({}),
    run: async (store) => {
      const stats = await store.stats();
      return Object.entries(stats)
        .filter(([, value]) => typeof value !== 'object' || value === null)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join('\n');
    },
  },
  {
    name: 'lcm_retrieval_debug',
    label: 'LCM Retrieval Debug',
    description: 'Show latest automatic retrieval diagnostics',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args, ctx) => await store.automaticRetrievalDebug(session(args, ctx)),
  },
  {
    name: 'lcm_resume',
    label: 'LCM Resume',
    description: 'Show the latest archived resume note',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.resume(args.sessionID),
  },
  {
    name: 'lcm_grep',
    label: 'LCM Grep',
    description: 'Search archived LCM capture with scope',
    approval: 'read',
    params: (z) =>
      z.object({
        query: z.string().min(1),
        sessionID: z.string().optional(),
        scope: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional(),
      }),
    run: async (store, args) =>
      formatSearchResults(
        await store.grep({
          query: args.query,
          sessionID: args.sessionID,
          scope: args.scope,
          limit: args.limit ?? 5,
        }),
      ),
  },
  {
    name: 'lcm_describe',
    label: 'LCM Describe',
    description: 'Summarize archived session capture with scope',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional(), scope: z.string().optional() }),
    run: async (store, args) =>
      await store.describe({ sessionID: args.sessionID, scope: args.scope }),
  },
  {
    name: 'lcm_lineage',
    label: 'LCM Lineage',
    description: 'Show archived branch lineage for a session',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.lineage(args.sessionID),
  },
  {
    name: 'lcm_pin_session',
    label: 'LCM Pin Session',
    description: 'Pin a session so retention pruning will skip it',
    approval: 'write',
    params: (z) => z.object({ sessionID: z.string().optional(), reason: z.string().optional() }),
    run: async (store, args) =>
      await store.pinSession({ sessionID: args.sessionID, reason: args.reason }),
  },
  {
    name: 'lcm_unpin_session',
    label: 'LCM Unpin Session',
    description: 'Remove a session retention pin',
    approval: 'write',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.unpinSession({ sessionID: args.sessionID }),
  },
  {
    name: 'lcm_expand',
    label: 'LCM Expand',
    description: 'Expand archived summary nodes into targeted descendants or raw messages',
    approval: 'read',
    params: (z) =>
      z.object({
        sessionID: z.string().optional(),
        nodeID: z.string().optional(),
        query: z.string().optional(),
        depth: z.number().int().min(1).max(4).optional(),
        messageLimit: z.number().int().min(1).max(20).optional(),
        includeRaw: z.boolean().optional(),
      }),
    run: async (store, args) =>
      await store.expand({
        sessionID: args.sessionID,
        nodeID: args.nodeID,
        query: args.query,
        depth: args.depth,
        messageLimit: args.messageLimit,
        includeRaw: args.includeRaw,
      }),
  },
  {
    name: 'lcm_artifact',
    label: 'LCM Artifact',
    description: 'View externalized archived content by artifact ID',
    approval: 'read',
    params: (z) =>
      z.object({
        artifactID: z.string().min(1),
        chars: z.number().int().min(200).max(20000).optional(),
      }),
    run: async (store, args) =>
      await store.artifact({ artifactID: args.artifactID, chars: args.chars }),
  },
  {
    name: 'lcm_blob_stats',
    label: 'LCM Blob Stats',
    description: 'Show deduplicated artifact blob stats',
    approval: 'read',
    params: (z) => z.object({ limit: z.number().int().min(1).max(20).optional() }),
    run: async (store, args) => await store.blobStats({ limit: args.limit }),
  },
  {
    name: 'lcm_blob_gc',
    label: 'LCM Blob GC',
    description: 'Preview or delete orphaned artifact blobs',
    approval: 'write',
    params: (z) =>
      z.object({
        apply: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    run: async (store, args) => await store.gcBlobs({ apply: args.apply, limit: args.limit }),
  },
  {
    name: 'lcm_compact',
    label: 'LCM Compact',
    description:
      'Measure and reclaim archive database space (prune internal events, checkpoint WAL, and VACUUM when worthwhile)',
    approval: 'write',
    params: (z) =>
      z.object({
        apply: z.boolean().optional(),
        vacuum: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    run: async (store, args) =>
      await store.compact({ apply: args.apply, vacuum: args.vacuum, limit: args.limit }),
  },
  {
    name: 'lcm_doctor',
    label: 'LCM Doctor',
    description: 'Inspect or repair archive summaries and indexes',
    approval: 'write',
    params: (z) =>
      z.object({
        apply: z.boolean().optional(),
        sessionID: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    run: async (store, args) =>
      await store.doctor({ apply: args.apply, sessionID: args.sessionID, limit: args.limit }),
  },
  {
    name: 'lcm_retention_report',
    label: 'LCM Retention Report',
    description: 'Preview stale-session and orphan-blob retention candidates',
    approval: 'read',
    params: (z) =>
      z.object({
        staleSessionDays: z.number().min(0).optional(),
        deletedSessionDays: z.number().min(0).optional(),
        orphanBlobDays: z.number().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    run: async (store, args) =>
      await store.retentionReport({
        staleSessionDays: args.staleSessionDays,
        deletedSessionDays: args.deletedSessionDays,
        orphanBlobDays: args.orphanBlobDays,
        limit: args.limit,
      }),
  },
  {
    name: 'lcm_retention_prune',
    label: 'LCM Retention Prune',
    description: 'Preview or apply stale-session and orphan-blob retention pruning',
    approval: 'write',
    params: (z) =>
      z.object({
        apply: z.boolean().optional(),
        staleSessionDays: z.number().min(0).optional(),
        deletedSessionDays: z.number().min(0).optional(),
        orphanBlobDays: z.number().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    run: async (store, args) =>
      await store.retentionPrune({
        apply: args.apply,
        staleSessionDays: args.staleSessionDays,
        deletedSessionDays: args.deletedSessionDays,
        orphanBlobDays: args.orphanBlobDays,
        limit: args.limit,
      }),
  },
  {
    name: 'lcm_export_snapshot',
    label: 'LCM Export Snapshot',
    description: 'Export a portable long-memory snapshot to a JSON file',
    approval: 'write',
    params: (z) =>
      z.object({
        filePath: z.string().min(1),
        sessionID: z.string().optional(),
        scope: z.string().optional(),
      }),
    run: async (store, args) =>
      await store.exportSnapshot({
        filePath: args.filePath,
        sessionID: args.sessionID,
        scope: args.scope,
      }),
  },
  {
    name: 'lcm_import_snapshot',
    label: 'LCM Import Snapshot',
    description: 'Import a portable long-memory snapshot from a JSON file',
    approval: 'write',
    params: (z) =>
      z.object({
        filePath: z.string().min(1),
        mode: z.string().optional(),
        worktreeMode: z.string().optional(),
      }),
    run: async (store, args) =>
      await store.importSnapshot({
        filePath: args.filePath,
        mode: args.mode === 'merge' ? 'merge' : 'replace',
        worktreeMode:
          args.worktreeMode === 'preserve' || args.worktreeMode === 'current'
            ? args.worktreeMode
            : 'auto',
      }),
  },
];

const errorResult = (text: string) => ({
  content: [{ type: 'text', text }],
  isError: true,
});

export function registerLcmTools(pi: Any, getRuntime: () => RuntimeLike | undefined): void {
  for (const spec of LCM_TOOL_SPECS) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      approval: spec.approval,
      parameters: spec.params(pi.zod),
      async execute(_id: string, params: Any, _signal: Any, _onUpdate: Any, ctx: ToolCtx) {
        const runtime = getRuntime();
        if (!runtime) return errorResult('LCM archive unavailable: no session started yet.');
        if (runtime.isDegraded()) {
          return errorResult('LCM archive unavailable: the store failed to initialize.');
        }
        try {
          const text = await spec.run(runtime.store(), params ?? {}, ctx);
          return { content: [{ type: 'text', text }] };
        } catch (error) {
          return errorResult(`${spec.name} failed: ${(error as Error).message}`);
        }
      },
    });
  }
}
```

`lcm_status` 的输出从源版 60+ 行手写 `k=v`（`src/index.ts:126-193`）改为遍历
`stats` 的标量字段。原版一半内容是回读 `options.*`，而配置来源已经变了
（Task 6），逐字照搬会输出误导性字段名。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test tests/omp-tools.test.mjs`
Expected: PASS，9 个用例。

- [ ] **Step 5: typecheck 与 lint**

Run: `bun run typecheck && bun run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat: register all 18 lcm tools as omp extension tools"
```

---

### Task 9: 全量测试与真机烟测

**Files:**
- Modify: `tests/*.test.mjs`（仅修导入路径，若有残留）
- Create: `README.md`

**Interfaces:**
- Consumes: 前 8 个 task 的全部产出
- Produces: 通过的测试套件 + 可安装的扩展。

- [ ] **Step 1: 跑全量套件**

Run: `cd /root/omp-lcm-kit && bun run test`
Expected: PASS。源仓库基线是 195 用例，新增约 51（Task 2-8），去掉重写的
`options-plugin.test.mjs`（6 个），预期 240 上下。

失败按类处理，**不要**靠改测试蒙过去：
- 报 `@opencode-ai/sdk` → Task 2 漏了某个文件的导入，补上。
- 报 `runtimeSafety` / `allowUnsafeBunWindows` → Task 6 Step 5 漏删，补上。
- 报 `NodeSidecarLcmStore` → `tests/store-compact.test.mjs` 有两个 sidecar 用例
  （源 `:322` `sidecar close rejects pending requests`、`:615` `sidecar timeout
  terminates the stuck worker`）。sidecar 已删除，**删掉这两个用例**——不是绕过，
  是被测对象不存在了。
- 报 Bun-on-Windows 相关（源 `tests/store.test.mjs:92-160`、
  `tests/startup-optimization.test.mjs:259`）→ 同上，删掉这些用例。

- [ ] **Step 2: 确认清理彻底**

```bash
cd /root/omp-lcm-kit
grep -rn "@opencode-ai\|OPENCODE_LCM_\|NodeSidecar\|allowUnsafeBunWindows" src/ tests/ ; echo "exit=$?"
```

Expected: 无输出，`exit=1`。

- [ ] **Step 3: 装成用户级扩展**

```bash
mkdir -p ~/.omp/agent/extensions
ln -sfn /root/omp-lcm-kit ~/.omp/agent/extensions/omp-lcm
```

目录形态经 `package.json#omp.extensions` 解析入口（`extension-loading.md`
Path and entry resolution），软链接被当作合法目录。

- [ ] **Step 4: 烟测——加载与归档**

```bash
cd /tmp && rm -rf lcm-smoke && mkdir lcm-smoke && cd lcm-smoke
omp -p "记住这个事实：租户映射写在 db.ts 的 resolveTenant 函数里。" 2>&1 | tail -20
ls -la .lcm/
```

Expected: 无扩展加载错误；`.lcm/lcm.db` 存在。

```bash
cd /tmp/lcm-smoke
omp -p "调用 lcm_status 工具并原样输出结果。" 2>&1 | tail -30
```

Expected: 输出含 `schema_version=2` 与非零 `session_count`。
若报 `LCM archive unavailable` → `store.init()` 失败，看 `pi.logger` 的 warn 详情。

- [ ] **Step 5: 烟测——落库校验**

```bash
cd /tmp/lcm-smoke
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('.lcm/lcm.db', { readOnly: true });
for (const t of ['sessions', 'messages', 'parts']) {
  console.log(t, db.prepare('SELECT COUNT(*) c FROM ' + t).get().c);
}
console.log('fts', db.prepare('SELECT COUNT(*) c FROM message_fts').get().c);
db.close();
"
```

Expected: 四项计数均 > 0。`messages` 为 0 说明 `message_end` 没接上或
`isValidWireMessage` 校验被打回——查 Task 4 的 `info` 构造。

- [ ] **Step 6: 烟测——召回**

```bash
cd /tmp/lcm-smoke
omp -p "调用 lcm_grep 工具，query 传 'tenant mapping'，原样输出结果。" 2>&1 | tail -20
omp -p "调用 lcm_retrieval_debug 工具并原样输出结果。" 2>&1 | tail -30
```

Expected: `lcm_grep` 返回含 `resolveTenant` 的命中；`lcm_retrieval_debug` 输出
召回决策（可能是 `below-transform-threshold`——默认 `minMessagesForTransform` 为 16，
短会话不触发注入，这是正确行为，不是缺陷）。

验证注入真的生效需要长会话。压低阈值单测一次：

```bash
cd /tmp/lcm-smoke
mkdir -p .omp && echo '{"minMessagesForTransform":2,"freshTailMessages":1}' > .omp/lcm.json
omp -p "刚才说的租户映射在哪个函数里？" 2>&1 | tail -20
omp -p "调用 lcm_retrieval_debug 工具并原样输出结果。" 2>&1 | tail -30
```

Expected: debug 输出的 `hitCount` > 0；上一轮回答提到 `resolveTenant`。

- [ ] **Step 7: 烟测——compaction**

```bash
cd /tmp/lcm-smoke
omp -p "运行 /compact，然后调用 lcm_resume 工具并原样输出结果。" 2>&1 | tail -30
```

Expected: `lcm_resume` 返回该会话的 resume note，而非
`No stored resume snapshot for that session.`

- [ ] **Step 8: 烟测——18 工具全过一遍**

```bash
cd /tmp/lcm-smoke
omp -p "依次调用这些工具并逐个报告是否报错：lcm_status, lcm_resume, lcm_describe, lcm_lineage, lcm_blob_stats, lcm_retention_report, lcm_doctor, lcm_compact, lcm_expand, lcm_retrieval_debug。写类工具不要传 apply。" 2>&1 | tail -40
omp -p "调用 lcm_export_snapshot，filePath 传 '/tmp/lcm-smoke/snap.json'，然后调用 lcm_import_snapshot 导入同一文件，mode 传 merge，报告结果。" 2>&1 | tail -20
```

Expected: 全部返回非错误结果。`lcm_pin_session`/`lcm_unpin_session`/`lcm_blob_gc`/
`lcm_retention_prune`/`lcm_artifact` 五个需要具体入参，单独验：

```bash
cd /tmp/lcm-smoke
omp -p "先 lcm_pin_session 固定当前会话，再 lcm_unpin_session 解除，然后 lcm_blob_gc 和 lcm_retention_prune 各跑一次预览（不传 apply），报告结果。" 2>&1 | tail -30
```

`lcm_artifact` 需要一个真实 artifact ID，从 `lcm_blob_stats` 输出里取；
若归档中没有超阈值内容（默认 `largeContentThreshold` 为 1200 字符）则没有 artifact，
此时记录「无 artifact 可测」而非视作失败。

- [ ] **Step 9: 写 README.md**

```markdown
# omp-lcm

Lossless context memory for [omp](https://omp.sh). Archives session history into
`.lcm/lcm.db` (SQLite + FTS5), compresses it into summary nodes, and recalls the
relevant parts back into the prompt when a later turn needs them.

Ported from [opencode-lcm](https://github.com/Plutarch01/opencode-lcm) (MIT).

## Install

```sh
git clone <this repo> ~/.omp/agent/extensions/omp-lcm
cd ~/.omp/agent/extensions/omp-lcm && bun install
```

omp discovers it through `package.json#omp.extensions`. Restart omp.

## Configure

No config is required. To override, create `~/.omp/agent/lcm.json` (user) or
`<project>/.omp/lcm.json` (project — wins over user):

```json
{
  "automaticRetrieval": { "enabled": true, "scopeOrder": ["session", "root", "worktree"] },
  "retention": { "staleSessionDays": 90, "deletedSessionDays": 30, "orphanBlobDays": 14 },
  "freshTailMessages": 10,
  "minMessagesForTransform": 16
}
```

Environment overrides beat both files: `OMP_LCM_FRESH_TAIL_MESSAGES`,
`OMP_LCM_MIN_MESSAGES_FOR_TRANSFORM`, `OMP_LCM_SUMMARY_CHAR_BUDGET`,
`OMP_LCM_AUTOMATIC_RETRIEVAL` (`0` disables recall), `OMP_LCM_SYSTEM_HINT`,
`OMP_LCM_SQLITE_RUNTIME`, `OMP_LCM_STARTUP_LOG`.

## Tools

`lcm_status`, `lcm_retrieval_debug`, `lcm_resume`, `lcm_grep`, `lcm_describe`,
`lcm_lineage`, `lcm_expand`, `lcm_artifact`, `lcm_pin_session`,
`lcm_unpin_session`, `lcm_blob_stats`, `lcm_blob_gc`, `lcm_compact`,
`lcm_doctor`, `lcm_retention_report`, `lcm_retention_prune`,
`lcm_export_snapshot`, `lcm_import_snapshot`.

## How it differs from the opencode original

- Archives on `message_end` instead of opencode's event bus; there are no
  part-level delta events in omp, so only settled messages are captured.
- Recall runs in the `context` event and returns a replacement message array
  (omp hands handlers a deep copy, so in-place rewriting would be discarded).
- Message ids are content-addressed rather than host-assigned: omp messages
  carry no id.
- No Bun-on-Windows Node sidecar. omp runs on Bun, where `bun:sqlite` is native.
- Configuration comes from `lcm.json` plus env, not a plugin argument array.

## License

MIT
```

- [ ] **Step 10: 复跑全量并提交**

Run: `bun run typecheck && bun run lint && bun run test`
Expected: 三项全 PASS

```bash
cd /root/omp-lcm-kit
rm -rf /tmp/lcm-smoke
git add -A && git commit -m "test: full suite green, add README"
```

---

## 自审记录

**Spec 覆盖检查**（对照 `docs/superpowers/specs/2026-08-19-omp-lcm-port-design.md`）：

| Spec 节 | 落在哪个 Task |
| --- | --- |
| §4.1 分层与 `wire-types.ts` | Task 1、2 |
| §4.2 ID 合成（内容哈希，不改 schema） | Task 3 |
| §4.3 归档路径（含 parentSession 判别） | Task 4、5 |
| §4.4 召回（`context` 返回替换数组、developer 消息注入 hint） | Task 7 |
| §4.5 compaction | Task 7 |
| §4.6 配置四层 | Task 6 |
| §4.7 删除项（sidecar、index.ts、Bun-Win 特判） | Task 1、6、9 |
| §5 错误处理（fail-soft、`ctx.setInterval`、init 失败降级） | Task 7 |
| §6 测试策略 | Task 2-9 |
| §7 验收标准 6 条 | Task 9 Step 4-8、Step 10 |

**已知缺口（有意留下，非遗漏）：**

- Spec §5 提到 retention 后台任务用 `ctx.setInterval`。源插件本身没有后台定时
  retention（`lcm_retention_prune` 是手动工具），所以本计划不新增——那会是超出
  移植范围的新功能。若日后要加，`ctx.setInterval` 是唯一正确入口。
- `lcm_status` 输出格式相对源版有变更（Task 8 Step 3 说明了理由）。
