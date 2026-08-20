import type { LcmStore } from '../lcm-store.js';
import type { SearchResult } from '../types.js';
import type { HostContext, HostExtensionApi, SchemaBuilder, ToolResult } from './host.js';

type ToolArgs = Record<string, unknown>;

type RuntimeLike = { isDegraded(): boolean; store(): LcmStore };

export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  approval: 'read' | 'write';
  params(z: SchemaBuilder): unknown;
  run(store: LcmStore, args: ToolArgs, ctx: HostContext): Promise<string>;
};

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** Fall back to the live session, mirroring opencode's `context.sessionID`
 *  default (src/index.ts:203-204 in the original plugin). */
const sessionOf = (args: ToolArgs, ctx: HostContext): string =>
  str(args.sessionID) ?? ctx.sessionManager.getSessionId();

function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No archived matches found.';
  return results
    .map((result) => {
      const suffix = result.sessionID ? ` session=${result.sessionID}` : '';
      return `[${result.type}]${suffix} ${result.snippet}`;
    })
    .join('\n\n');
}

const retentionArgs = (args: ToolArgs) => ({
  staleSessionDays: num(args.staleSessionDays),
  deletedSessionDays: num(args.deletedSessionDays),
  orphanBlobDays: num(args.orphanBlobDays),
  limit: num(args.limit),
});

/** Ported from the opencode plugin's tool table (src/index.ts:121-460).
 *  Parameter bounds are carried over verbatim. */
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
        .filter(([, value]) => value === null || typeof value !== 'object')
        .map(([key, value]) => `${key}=${value ?? 'n/a'}`)
        .join('\n');
    },
  },
  {
    name: 'lcm_retrieval_debug',
    label: 'LCM Retrieval Debug',
    description: 'Show latest automatic retrieval diagnostics',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args, ctx) => await store.automaticRetrievalDebug(sessionOf(args, ctx)),
  },
  {
    name: 'lcm_resume',
    label: 'LCM Resume',
    description: 'Show the latest archived resume note',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.resume(str(args.sessionID)),
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
          query: str(args.query) ?? '',
          sessionID: str(args.sessionID),
          scope: str(args.scope),
          limit: num(args.limit) ?? 5,
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
      await store.describe({ sessionID: str(args.sessionID), scope: str(args.scope) }),
  },
  {
    name: 'lcm_lineage',
    label: 'LCM Lineage',
    description: 'Show archived branch lineage for a session',
    approval: 'read',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.lineage(str(args.sessionID)),
  },
  {
    name: 'lcm_pin_session',
    label: 'LCM Pin Session',
    description: 'Pin a session so retention pruning will skip it',
    approval: 'write',
    params: (z) => z.object({ sessionID: z.string().optional(), reason: z.string().optional() }),
    run: async (store, args) =>
      await store.pinSession({ sessionID: str(args.sessionID), reason: str(args.reason) }),
  },
  {
    name: 'lcm_unpin_session',
    label: 'LCM Unpin Session',
    description: 'Remove a session retention pin',
    approval: 'write',
    params: (z) => z.object({ sessionID: z.string().optional() }),
    run: async (store, args) => await store.unpinSession({ sessionID: str(args.sessionID) }),
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
        sessionID: str(args.sessionID),
        nodeID: str(args.nodeID),
        query: str(args.query),
        depth: num(args.depth),
        messageLimit: num(args.messageLimit),
        includeRaw: bool(args.includeRaw),
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
      await store.artifact({ artifactID: str(args.artifactID) ?? '', chars: num(args.chars) }),
  },
  {
    name: 'lcm_blob_stats',
    label: 'LCM Blob Stats',
    description: 'Show deduplicated artifact blob stats',
    approval: 'read',
    params: (z) => z.object({ limit: z.number().int().min(1).max(20).optional() }),
    run: async (store, args) => await store.blobStats({ limit: num(args.limit) }),
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
    run: async (store, args) =>
      await store.gcBlobs({ apply: bool(args.apply), limit: num(args.limit) }),
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
      await store.compact({
        apply: bool(args.apply),
        vacuum: bool(args.vacuum),
        limit: num(args.limit),
      }),
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
      await store.doctor({
        apply: bool(args.apply),
        sessionID: str(args.sessionID),
        limit: num(args.limit),
      }),
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
    run: async (store, args) => await store.retentionReport(retentionArgs(args)),
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
      await store.retentionPrune({ apply: bool(args.apply), ...retentionArgs(args) }),
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
        filePath: str(args.filePath) ?? '',
        sessionID: str(args.sessionID),
        scope: str(args.scope),
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
    run: async (store, args) => {
      // Normalized here rather than in the schema, matching the original plugin
      // (src/index.ts:453-458): an unrecognized value falls back to the safe
      // default instead of failing the call.
      const worktreeMode = str(args.worktreeMode);
      return await store.importSnapshot({
        filePath: str(args.filePath) ?? '',
        mode: args.mode === 'merge' ? 'merge' : 'replace',
        worktreeMode:
          worktreeMode === 'preserve' || worktreeMode === 'current' ? worktreeMode : 'auto',
      });
    },
  },
];

const errorResult = (text: string): ToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

export function registerLcmTools(
  pi: HostExtensionApi,
  getRuntime: () => RuntimeLike | undefined,
): void {
  for (const spec of LCM_TOOL_SPECS) {
    pi.registerTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      approval: spec.approval,
      parameters: spec.params(pi.zod),
      async execute(_id, params, _signal, _onUpdate, ctx): Promise<ToolResult> {
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
