# opencode-lcm → omp 移植设计

**日期:** 2026-08-19
**路线:** A（适配层），召回走 `context` 事件返回替换后的 messages
**目标产物:** omp extension 包 `omp-lcm`，位于本仓库 `/root/omp-lcm-kit`

## 1. 问题陈述

`/root/opencode-lcm` 是 OpenCode 插件：`src/` 24 文件 11,323 行，`tests/` 20 文件 8,167 行 / 195 用例。
它把会话历史归档进 `.lcm/lcm.db`（SQLite + FTS5），压缩成摘要节点，并在后续轮次按需召回。

宿主耦合面远小于体量。实测（见 §2）只用了 4 个 opencode hook 与 1 个 `ctx` 字段；
`ctx.client`（OpenCode server SDK）零调用。真正的成本在**消息数据模型**：
store 以 opencode 的 `{ info: Message; parts: Part[] }` 为键建表，`.info` 引用 110 处、
`.parts` 22 处、`part.type` 分支 `store.ts` 90 处 + `store-artifacts.ts` 60 处。

## 2. 源端实测（证据）

### 2.1 宿主 hook 全集

| hook | 位置 | 用到的入参 |
| --- | --- | --- |
| `event` | `src/index.ts:116-118` | 整个 `event`，透传 `store.captureDeferred(event)` |
| `experimental.chat.messages.transform` | `src/index.ts:463-465` | 仅 `output.messages`，**原地改写** |
| `experimental.chat.system.transform` | `src/index.ts:467-471` | `output.system.push(hint)` |
| `experimental.session.compacting` | `src/index.ts:473-478` | `input.sessionID`、`output.context: string[]` |
| `tool` 表 | `src/index.ts:120-461` | 18 个 `lcm_*` 工具（README 写 17，实测 18） |

未使用：`chat.params`、`tool.execute.before/after`、`config`、`auth`、`permission.ask`。
安全降级形状见 `src/index.ts:62-80`——四个 hook 均可 no-op，说明它们互相独立。

### 2.2 `ctx` 使用面

唯一调用点 `src/index.ts:105` `createStore(ctx.directory, ...)`。
worktree 概念由插件自己从事件负载 `session.info.directory` 推导
（`src/store.ts:5507`、`src/worktree-key.ts:1-5`），不依赖宿主 `ctx.worktree`。

**结论：server SDK 缺口为零。**

### 2.3 消费的事件类型与字段

`src/store.ts` 分派于 `payload.type`：
`session.created` / `session.updated` / `session.deleted` / `session.compacted`
（读 `properties.info.{title,directory,parentID}`，`store.ts:5504-5519`）、
`message.updated`（`properties.info`）、`message.removed`（`properties.messageID`）、
`message.part.updated`（`properties.part.{id,messageID,type,...}`）、`message.part.removed`。
`message.part.delta` 被显式忽略。

Part 形状（由 `tests/helpers.mjs:138-182` 反推，与 store 消费一致）：
`{ id, sessionID, messageID, type }` 加类型特有字段——
`text`: `text`/`metadata`；`reasoning`: `text`/`time`；
`tool`: `callID`/`tool`/`state{status,input,output|error,title,metadata,time,attachments}`；
`file`: `source{path,text{value,start,end}}`/`filename`/`mime`；`snapshot`/`agent`/`subtask`。

### 2.4 环境变量

`OPENCODE_LCM_{ALLOW_UNSAFE_BUN_WINDOWS,NODE_PATH,SIDECAR_TIMEOUT_MS,SQLITE_RUNTIME,STARTUP_LOG}`。
前三个专属 Bun-on-Windows sidecar，随 sidecar 一起删除。

## 3. 目标端实测（证据）

全部对照本地源码 `/root/node_modules/@oh-my-pi/pi-coding-agent/src`，非文档推测。

### 3.1 能力映射

| opencode 能力 | omp 对应物 | 证据 | 语义差异 |
| --- | --- | --- | --- |
| `event` 归档流 | `message_end` + `turn_end` + session 生命周期事件 | `extensions/types.ts:748-751`；`shared-events.ts:212-216` | **最大缺口**：omp 无统一事件总线，无 part 级增量事件 |
| `messages.transform` | `context` 事件 | `shared-events.ts:179-183`；`extensions/types.ts:1068-1070, 1216` | omp 给**深拷贝**，必须 `return { messages }`；多 handler 链式 |
| `system.transform` | 无 | `ExtensionContext.getSystemPrompt()` 只读（`extensions/types.ts:477`） | 改为在 `context` 里注入 `developer` 消息 |
| `session.compacting` | `session.compacting` → `{ context?: string[] }` | `shared-events.ts:77-81, 384-387` | 近乎一对一 |
| `tool({...})` | `pi.registerTool` | `extensions/types.ts:577-627` | `args`→`parameters`（`pi.zod` 已注入）；返回 `AgentToolResult` 而非 `string` |
| 插件参数 `["name",{opts}]` | 无 | `SettingPath = keyof Schema`（`settings-schema.ts:5590`） | 需自带配置文件 |
| SQLite | `bun:sqlite` 原生 | `tools/read.ts`、`tools/write.ts` 已在用 | sidecar 整层可删 |

### 3.2 消息模型差异（移植主体）

omp：`AgentMessage = Message | CustomAgentMessages[...]`（`pi-agent-core/src/types.ts:660`），
`Message = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage`
（`pi-ai/src/types.ts:964`）。扁平 `{ role, content[], timestamp }`，**消息本身无 id**。

内容块：`TextContent`(686)、`ThinkingContent`(692)、`ImageContent`(741)、`ToolCall`(797, 有 `id`)；
`ToolResultMessage`(942) 独立成消息，带 `toolCallId`/`toolName`/`isError`/`details`。

ID 只存在于会话条目层 `SessionEntryBase.{id,parentId}`（8 字符，`session-entries.ts`），
且 `message_end` 触发时条目可能尚未落盘（`agent-session.ts:2591` 的 `#createMessageEndPersistenceSlot`）。

**决定：ID 由适配层自行合成，不依赖会话条目 id。** 见 §4.2。

### 3.3 加载与配置

扩展目录：`<cwd>/.omp/extensions`、`~/.omp/agent/extensions`，或 `extensions:` 设置项显式路径。
目录形态下 `package.json#omp.extensions` 声明入口，**支持 node_modules 依赖**
（示例 `examples/extensions/with-deps/package.json`）。TS 由 Bun 直接加载，**无构建步骤**。

## 4. 设计

### 4.1 分层

```
omp 事件 ──▶ adapter/ ──▶ (合成的 {info, parts}) ──▶ store.ts（几乎不动）
                │
                └── ids.ts（稳定 ID 合成）
context 事件 ◀── recall.ts ◀── store.transformMessages()
```

新增目录 `src/omp/`，内容：

| 文件 | 职责 |
| --- | --- |
| `extension.ts` | 扩展入口：注册事件、18 工具、`/lcm` 命令 |
| `adapter-events.ts` | omp 事件 → opencode 形状的 `Event`，喂给 `store.captureDeferred` |
| `adapter-messages.ts` | `AgentMessage` ⇄ `ConversationMessage`（双向，召回要回写） |
| `ids.ts` | 稳定 `sessionID`/`messageID`/`partID` 合成 |
| `config.ts` | 配置加载（替代 opencode 插件传参） |
| `tools.ts` | 18 个 `pi.registerTool` 定义 |

`store.ts` 及其 6,291 行、`store-*.ts`、`search-ranking.ts`、`privacy.ts`、
`preview-providers.ts`、`options.ts`、`types.ts` 原样保留。
`types.ts` 顶部 `import type { Message, Part } from '@opencode-ai/sdk'` 替换为本地
`src/wire-types.ts`（依据 §2.3 实测形状手写），彻底断开 opencode 依赖。

### 4.2 ID 合成

会话条目 id 不可用（`message_end` 时条目可能尚未落盘，
`agent-session.ts:2591` 的 `#createMessageEndPersistenceSlot`）。
单调计数器同样不可用：会话恢复后计数从零重启，同一条消息会拿到不同 ID，
归档出重复行。改用内容哈希：

- `sessionID` = `ctx.sessionManager.getSessionId()`（`session-manager.ts:1945`，稳定）
- `messageID` = `m_${hashContent(sessionID + role + timestamp + contentDigest).slice(0, 16)}`，
  复用 `src/utils.ts:70` 的 `hashContent`。`timestamp` 每条 `AgentMessage` 都有
  （`pi-ai/src/types.ts:844, 937, 961`），毫秒级；同一会话内 role + timestamp +
  内容摘要三者相同即视为同一条消息，这正是幂等所需的语义。
- `partID` = `${messageID}_p${contentIndex}`；`ToolCall` 用其自带 `id`（`pi-ai/src/types.ts:799`）
- 归档只在 `message_end` 触发（消息此时已终态），不需要 part 级增量合并

**不变量：** 同一条 `AgentMessage` 无论映射多少次、是否跨进程，都得到同一组 ID。
`WeakMap<AgentMessage, MessageIds>` 仅作进程内加速，不影响正确性。

**不改 SQLite schema。** `STORE_SCHEMA_VERSION` 保持 2（`src/constants.ts:12`），
`sessions` 表（`src/store.ts:1228-1242`）不加列——`messages.message_id` 是主键，
哈希 ID 直接落进去，重复归档由 upsert 吸收。

### 4.3 归档路径

| omp 事件 | 合成的 opencode 事件 | 备注 |
| --- | --- | --- |
| `session_start` | `session.created` | `info` 由 `sessionManager.getHeader()` + `ctx.cwd` 拼 |
| `session_switch` | `session.updated` | 负载只有 `reason: "new"｜"resume"｜"fork"｜"handoff"`（`shared-events.ts:42-45`），无 session 字段 |
| `session_branch` | `session.updated` | 负载只有 `previousSessionFile`（`shared-events.ts:58-61`），无 parent 字段 |
| `session_compact` | `session.compacted` | 带 `compactionEntry`、`fromExtension`（`shared-events.ts:84-89`） |
| `message_end` | `message.updated` + 每内容块一个 `message.part.updated` | 消息此时已终态 |
| `session_shutdown` | 调 `store.close()` | 不是归档事件 |

**switch/branch 的父子关系不能从事件负载取**——两者都不带 session 标识。
统一从 `ctx.sessionManager.getHeader().parentSession` 读；该字段是不带类型约束的
opaque 谱系串（可能是 session id，也可能是路径，见 `session.md` 头部说明），
因此 `adapter-events.ts` 必须先判别形态：像路径就取 basename 里的 session id，
否则直接当 id 用。判别不出就写 `undefined`——store 侧 `parentID` 本就可空
（`src/store.ts:5508`）。

`message_update`（流式增量）**不订阅**——store 侧 `message.part.delta` 本就忽略。
`ToolResultMessage` 映射为归属于其 `toolCallId` 所在 assistant 消息的 `tool` part，
状态 `completed`/`error` 依 `isError` 决定，与 `tests/helpers.mjs:146-182` 形状一致。

### 4.4 召回路径

```ts
pi.on("context", async (event) => {
  const conv = toConversationMessages(event.messages);   // adapter-messages
  const changed = await store.transformMessages(conv);   // 原地改写，不动签名
  if (!changed) return;                                  // 未命中：不返回，省一次拷贝
  return { messages: toAgentMessages(conv, event.messages) };
});
```

`toAgentMessages` 以原 `AgentMessage` 为模板回写，仅替换 `content`，保留
`api`/`provider`/`model`/`usage`/`stopReason`/`providerPayload` 等 provider 字段——
丢掉这些会破坏 transport-native 重放。

`if (!changed) return;` 是安全的：`transformMessages` 返回 `false` 的三条早退路径
（`store.ts:3766, 3792, 3821`）都未改动数组，而 `:3742` 的 `splice` 在本路径永不触发——
`filterValidConversationMessages` 对 `operation === 'transformMessages'` 直接原样返回
（`store.ts:387`）。因此 `false` 严格等于「未改动」。

system hint（`store.systemHint()`）改为在 `context` 返回的数组头部插入一条
`{ role: "developer", content: hint, timestamp }`，等价于原 `system.transform` 的效果。

### 4.5 compaction

```ts
pi.on("session.compacting", async (event) => {
  const note = await store.buildCompactionContext(event.sessionId);
  if (!note) return;
  return { context: [note] };
});
```

原去重判断（`index.ts:476` 检查 `output.context` 已含 note）不再需要：omp 每次
compaction 只发一次该事件，且 `context` 由我们独立返回，不与他人共享数组。

### 4.6 配置

自带配置，不走 `Settings`（`SettingPath` 受 schema 约束，任意 `lcm.*` 非法路径）。

加载顺序（后者覆盖前者）：
1. `DEFAULT_OPTIONS`（`src/options.ts:69`，原样复用）
2. `~/.omp/agent/lcm.json`
3. `<cwd>/.omp/lcm.json`
4. 环境变量 `OMP_LCM_*`

`resolveOptions`（`src/options.ts`）原样复用做归一化与容错——它已被
`tests/options-plugin.test.mjs:51` 覆盖畸形输入。

### 4.7 删除项

- `src/node-sidecar.ts` + `src/node-sidecar-store.ts`（533 行）及其
  `OPENCODE_LCM_{ALLOW_UNSAFE_BUN_WINDOWS,NODE_PATH,SIDECAR_TIMEOUT_MS}`
- `src/index.ts`（opencode 插件入口，由 `src/omp/extension.ts` 取代）
- `src/store.ts` 内 Bun-on-Windows 特判：`resolveCaptureHydrationMode` 的 win32 分支、
  `store.ts:747-748` 的 deferred-part 特判

保留 `resolveSqliteRuntime`（`bun:sqlite` / `node:sqlite` 二选一）：现有测试用
`node:sqlite` 的 `DatabaseSync` 直连，删掉会连带废掉大量单元测试，收益为负。

## 5. 错误处理

- 归档失败绝不影响会话：所有 `pi.on` handler 内部 try/catch，失败仅 `pi.logger.warn`。
  依据：omp 扩展不沙箱（`extension-loading.md`），未捕获抛出会经扩展错误通道上报。
- 后台定时任务（retention）用 `ctx.setInterval`（`extensions/types.ts:489`），
  裸 `setInterval` 抛出会被当作 process-fatal 拖垮整个会话。
- `store.init()` 失败 → 进入 no-op 模式，只保留 `lcm_status` 报告故障原因，
  对齐原 `createSafeModeHooks`（`src/index.ts:62-80`）的降级形状。

## 6. 测试策略

- **原样复用**：不碰宿主 API 的单元测试——`utils`、`sql-utils`、`store-schema`、
  `store-session-read`、`store-retention`、`search-ranking`、`workspace-path`、
  `preview-providers`、`summary-strategy`、`logging`。
- **改导入即可**：`store*.test.mjs`、`migration-snapshot`、`startup-optimization`——
  它们直接调 `SqliteLcmStore`，只需把 `@opencode-ai/sdk` 类型导入换成 `wire-types`。
- **重写**：`options-plugin.test.mjs`——插件入口与配置机制都变了。
- **新增**：`adapter-messages`（往返保真：ID 稳定、provider 字段不丢）、
  `adapter-events`（每种 `AgentMessage` → 正确 part 形状）、`config`（四层覆盖顺序）。
- **烟测**：真机跑 `omp`，验证归档落库、召回注入、compaction note 三条链路。

## 7. 验收标准

1. `omp` 启动加载扩展无错，`lcm_status` 报告 schema 版本与非零 `session_count`。
2. 跑完一轮对话后 `.lcm/lcm.db` 出现该会话的 messages/parts/FTS 行。
3. 新会话中提问历史内容，`lcm_retrieval_debug` 显示命中且 `context` 注入生效。
4. 触发 compaction，`lcm_resume` 返回该会话的 resume note。
5. 18 个工具全部可调用并返回非错误结果。
6. 测试全绿，且新增适配层测试覆盖 ID 稳定性与 provider 字段保真。

## 8. 非目标

- 不做 omp `memory` 后端集成（`ctx.memory` 是另一套抽象，
  `memory-backend/types.ts:79-82`）。LCM 作为独立 extension 与之并存。
- 不改召回排序算法。
- 不支持 opencode 与 omp 双宿主——单向移植，清理式切换。
