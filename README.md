# omp-lcm

Lossless context memory for [omp](https://omp.sh). Archives session history into
`.lcm/lcm.db` (SQLite + FTS5), compresses it into summary nodes, and recalls the
relevant parts back into the prompt when a later turn needs them.

Ported from [opencode-lcm](https://github.com/Plutarch01/opencode-lcm) (MIT).
Substantial portions of the archive, summary, search, and retention logic are
reused from it unmodified; both copyright notices are retained in `LICENSE`.

## Install

```sh
git clone <this repo> ~/.omp/agent/extensions/omp-lcm
cd ~/.omp/agent/extensions/omp-lcm && bun install && bun run build
```

omp discovers it through `package.json#omp.extensions`. Restart omp.

`bun run build` is needed because the test suite imports from `dist/`; omp itself
loads the TypeScript sources directly.

## Configure

No config is required. To override, create `~/.omp/agent/lcm.json` (user) or
`<project>/.omp/lcm.json` (project — wins over user, merged per nested key):

```json
{
  "automaticRetrieval": {
    "enabled": true,
    "scopeOrder": ["session", "root", "worktree"],
    "scopeBudgets": { "session": 16, "root": 12, "worktree": 8, "all": 6 }
  },
  "retention": { "staleSessionDays": 90, "deletedSessionDays": 30, "orphanBlobDays": 14 },
  "privacy": { "redactPatterns": ["sk-[A-Za-z0-9_-]+"] },
  "freshTailMessages": 10,
  "minMessagesForTransform": 16
}
```

Environment variables beat both files:

| Variable | Effect |
| --- | --- |
| `OMP_LCM_FRESH_TAIL_MESSAGES` | Recent messages left uncompressed |
| `OMP_LCM_MIN_MESSAGES_FOR_TRANSFORM` | Threshold below which recall is skipped |
| `OMP_LCM_SUMMARY_CHAR_BUDGET` | Summary size budget |
| `OMP_LCM_AUTOMATIC_RETRIEVAL` | `0` disables recall |
| `OMP_LCM_SYSTEM_HINT` | `0` suppresses the injected hint |
| `OMP_LCM_SQLITE_RUNTIME` | `bun` or `node` |
| `OMP_LCM_STARTUP_LOG` | `1` logs store startup phases |

## Tools

`lcm_status`, `lcm_retrieval_debug`, `lcm_resume`, `lcm_grep`, `lcm_describe`,
`lcm_lineage`, `lcm_expand`, `lcm_artifact`, `lcm_pin_session`,
`lcm_unpin_session`, `lcm_blob_stats`, `lcm_blob_gc`, `lcm_compact`,
`lcm_doctor`, `lcm_retention_report`, `lcm_retention_prune`,
`lcm_export_snapshot`, `lcm_import_snapshot`.

Read-only tools are registered with `approval: "read"`; mutating ones with
`approval: "write"`.

`lcm_retrieval_debug` reads an in-process map, not the database. Its telemetry is
only visible within the session that produced it — a fresh `omp -p` invocation
sees nothing. This is inherited behavior from the original plugin.

## Architecture

An adapter layer translates omp's runtime into the shapes the original store
expects, so `store.ts` and its 6,000+ lines of archive, summary, search, and
retention logic are reused unmodified.

```
omp events ──▶ src/omp/adapter-events.ts  ──▶ { info, parts } ──▶ store.ts
                        │
                        └── src/omp/ids.ts  (content-addressed ids)

context event ◀── src/omp/extension.ts ◀── store.transformMessages()
```

| File | Responsibility |
| --- | --- |
| `src/omp/extension.ts` | Extension entry, event wiring, fail-soft handlers |
| `src/omp/adapter-events.ts` | omp lifecycle events → opencode capture events |
| `src/omp/adapter-messages.ts` | `AgentMessage` ⇄ `ConversationMessage`, both directions |
| `src/omp/ids.ts` | Stable message/part id synthesis |
| `src/omp/pending-tools.ts` | Open tool calls awaiting their result |
| `src/omp/config.ts` | Layered config loading |
| `src/omp/tools.ts` | The 18 tool definitions |
| `src/omp/host.ts` | Structural types for the host API slice used |
| `src/wire-types.ts` | The opencode wire shapes, ported locally |

## How it differs from the opencode original

- **Archives on `message_end`.** omp has no unified event bus and no part-level
  delta events, so only settled messages are captured. The store already ignored
  `message.part.delta`, so nothing is lost.
- **Tool calls and their results are re-joined across events.** opencode models a
  call and its result as one part; omp delivers them as two separate messages.
  `src/omp/pending-tools.ts` remembers where each unsettled call was archived so
  the result updates that same part. Without it a tool part would stay
  `status: "pending"` forever, its output would be archived as an unrelated text
  part, and the store's tool-output privacy redaction — which is keyed on a
  settled tool part — would never fire.
- **Recall runs in the `context` event** and returns a replacement message array.
  omp hands handlers a deep copy, so in-place rewriting would be discarded.
- **The system hint rides in as a `developer` message.** omp has no equivalent of
  opencode's `system.transform`, and `ctx.getSystemPrompt()` is read-only.
- **Message ids are content-addressed.** omp messages carry no host-assigned id,
  and session-entry ids may not be persisted when `message_end` fires. Hashing
  (session, role, timestamp, content) is idempotent across processes, which is
  what the store's primary key needs — a counter would restart on resume and
  double-archive.
- **No Bun-on-Windows Node sidecar.** omp runs on Bun, where `bun:sqlite` is
  native; the sidecar and its three environment variables are gone.
- **Configuration comes from `lcm.json` plus env**, not a plugin argument array.
  omp's `SettingPath` is closed over a fixed schema, so `lcm.*` is not a legal
  setting path.
- **The host API is typed structurally** (`src/omp/host.ts`) rather than imported
  from `@oh-my-pi/pi-coding-agent`, so the extension is not pinned to one host
  version.

## Development

```sh
bun run typecheck
bun run lint
bun run test
```

The suite passes as root and as an unprivileged user. Tests that need an
unwritable database go through `withUnwritableFile` in `tests/helpers.mjs`:
`chmod 0o444` does not block uid 0, since `DAC_OVERRIDE` lets root write any file
regardless of mode, so as root the helper sets the immutable attribute
(`chattr +i`) instead — the kernel enforces that for every uid. On a filesystem
without immutability support (some tmpfs/overlayfs mounts) those two tests fail
with an explicit message rather than passing vacuously; run them as an
unprivileged user there.

## License

MIT
