/**
 * The slice of omp's `ExtensionAPI` this extension actually uses.
 *
 * Declared structurally rather than imported from `@oh-my-pi/pi-coding-agent`:
 * depending on the host package would pin the extension to one host version,
 * and omp injects these members at load time regardless. The surface is small
 * enough to state precisely, so nothing here needs `any`.
 */

export type HostLogger = {
  warn(message: string, detail?: unknown): void;
  debug?(message: string, detail?: unknown): void;
};

/** Chainable schema node. omp injects a Zod-compatible builder as `pi.zod`
 *  (extensions/types.ts:1186); only the combinators used here are declared. */
export type SchemaNode = {
  optional(): SchemaNode;
  min(value: number): SchemaNode;
  max(value: number): SchemaNode;
  int(): SchemaNode;
  describe(text: string): SchemaNode;
  default(value: unknown): SchemaNode;
};

export type SchemaBuilder = {
  object(shape: Record<string, SchemaNode>): unknown;
  string(): SchemaNode;
  number(): SchemaNode;
  boolean(): SchemaNode;
};

/** Read-only session view. Mirrors the members of omp's `ReadonlySessionManager`
 *  this extension reads (session-manager.ts:1945, 2409). */
export type HostSessionManager = {
  getSessionId(): string;
  getHeader(): { title?: string; parentSession?: string } | undefined;
};

/** Handler/tool context. Mirrors `ExtensionContext` (extensions/types.ts:443). */
export type HostContext = {
  cwd: string;
  sessionManager: HostSessionManager;
};

export type ToolResultContent = { type: 'text'; text: string };

export type ToolResult = {
  content: ToolResultContent[];
  details?: unknown;
  isError?: boolean;
};

/** Subset of `ToolDefinition` (extensions/types.ts:577-627). */
export type HostToolDefinition = {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  approval?: 'read' | 'write' | 'exec';
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: HostContext,
  ): Promise<ToolResult>;
};

/** Payload shapes for the events this extension subscribes to. */
export type HostMessageEndEvent = { message: unknown };
export type HostContextEvent = { messages: unknown[] };
export type HostCompactingEvent = { sessionId: string };

export type HostExtensionApi = {
  logger: HostLogger;
  zod: SchemaBuilder;
  setLabel?(label: string): void;
  registerTool(definition: HostToolDefinition): void;
  on(event: string, handler: (event: never, ctx: HostContext) => unknown): void;
};
