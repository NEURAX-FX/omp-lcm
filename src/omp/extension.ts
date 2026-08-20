import type { LcmStore } from '../lcm-store.js';
import { SqliteLcmStore } from '../store.js';
import { messageEvents, parseParentSession, sessionEvent } from './adapter-events.js';
import { applyRecalledContent, toConversationMessages } from './adapter-messages.js';
import { loadOptions } from './config.js';
import type {
  HostCompactingEvent,
  HostContext,
  HostContextEvent,
  HostExtensionApi,
  HostLogger,
  HostMessageEndEvent,
} from './host.js';
import { registerLcmTools } from './tools.js';

export type LcmRuntime = {
  onSessionStart(ctx: HostContext): Promise<void>;
  onSessionUpdate(ctx: HostContext, kind: 'updated' | 'compacted'): Promise<void>;
  onMessageEnd(ctx: HostContext, message: unknown): Promise<void>;
  onContext(ctx: HostContext, messages: unknown[]): Promise<{ messages: unknown[] } | undefined>;
  onCompacting(ctx: HostContext, sessionId: string): Promise<{ context: string[] } | undefined>;
  onShutdown(): Promise<void>;
  isDegraded(): boolean;
  store(): LcmStore;
};

/**
 * Extension logic with injected dependencies.
 *
 * Every handler is fail-soft. Archiving is a side channel: a store failure must
 * degrade recall, never break the session. Extensions also run unsandboxed and
 * in-process, so an escaping throw would surface as a session-level error.
 */
export function createRuntime(deps: { store: LcmStore; logger: HostLogger }): LcmRuntime {
  const { store, logger } = deps;
  let started = false;
  let degraded = false;
  let closed = false;

  const active = () => started && !degraded && !closed;

  async function guard(operation: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      logger.warn(`omp-lcm ${operation} failed`, error);
    }
  }

  async function captureSession(
    ctx: HostContext,
    kind: 'created' | 'updated' | 'compacted',
  ): Promise<void> {
    const header = ctx.sessionManager.getHeader();
    await guard(`session.${kind} capture`, async () => {
      await store.captureDeferred(
        sessionEvent(kind, {
          sessionID: ctx.sessionManager.getSessionId(),
          title: header?.title,
          directory: ctx.cwd,
          parentSessionID: parseParentSession(header?.parentSession),
        }),
      );
    });
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

      await captureSession(ctx, 'created');
    },

    async onSessionUpdate(ctx, kind) {
      if (!active()) return;
      await captureSession(ctx, kind);
    },

    async onMessageEnd(ctx, message) {
      if (!active()) return;
      await guard('message capture', async () => {
        for (const event of messageEvents(ctx.sessionManager.getSessionId(), [message])) {
          await store.captureDeferred(event);
        }
      });
    },

    async onContext(ctx, messages) {
      if (!active()) return undefined;

      try {
        const sessionID = ctx.sessionManager.getSessionId();
        const conv = toConversationMessages(sessionID, messages);
        const changed = await store.transformMessages(conv);
        // `false` strictly means "untouched": every early return in
        // transformMessages leaves the array alone, and its splice path is
        // unreachable for this operation (store.ts:387).
        if (!changed) return undefined;

        const rewritten = applyRecalledContent(sessionID, messages, conv);
        const hint = store.systemHint();
        if (!hint) return { messages: rewritten };

        // omp exposes no equivalent of opencode's system.transform, and
        // ctx.getSystemPrompt() is read-only, so the hint rides in as a
        // developer message at the head of the context.
        return {
          messages: [{ role: 'developer', content: hint, timestamp: Date.now() }, ...rewritten],
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

export default function ompLcm(pi: HostExtensionApi): void {
  let runtime: LcmRuntime | undefined;

  pi.setLabel?.('LCM (lossless context memory)');

  // The store is built on first use rather than at load time: runtime action
  // methods are unavailable during extension load, and cwd only arrives with a
  // handler context.
  const ensure = (ctx: HostContext): LcmRuntime => {
    if (!runtime) {
      runtime = createRuntime({
        store: new SqliteLcmStore(ctx.cwd, loadOptions(ctx.cwd)),
        logger: pi.logger,
      });
    }
    return runtime;
  };

  pi.on('session_start', async (_event, ctx) => {
    await ensure(ctx).onSessionStart(ctx);
  });

  pi.on('session_switch', async (_event, ctx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'updated');
  });

  pi.on('session_branch', async (_event, ctx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'updated');
  });

  pi.on('session_compact', async (_event, ctx) => {
    await ensure(ctx).onSessionUpdate(ctx, 'compacted');
  });

  pi.on('message_end', async (event: HostMessageEndEvent, ctx) => {
    await ensure(ctx).onMessageEnd(ctx, event.message);
  });

  pi.on('context', async (event: HostContextEvent, ctx) => {
    return await ensure(ctx).onContext(ctx, event.messages);
  });

  pi.on('session.compacting', async (event: HostCompactingEvent, ctx) => {
    return await ensure(ctx).onCompacting(ctx, event.sessionId);
  });

  pi.on('session_shutdown', async () => {
    await runtime?.onShutdown();
  });

  registerLcmTools(pi, () => runtime);
}
