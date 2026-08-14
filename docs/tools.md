# Tools & Automatic Behavior

The ten `mem*` tools and the automatic enhancement/synchronization layers.

## Tools

All ten tools talk HTTP to the OpenViking service. Failures throw — the model
never sees fake `"Error: ..."` success values.

| Tool | Description |
| --- | --- |
| `memsearch` | Semantic search (`auto`/`fast`/`deep`; deep uses session context) |
| `memfind` | Fast semantic find without session context |
| `memread` | Read a `viking://` URI (`abstract`/`overview`/`read`/`auto`) |
| `membrowse` | `list`/`tree`/`stat` views of the `viking://` filesystem |
| `memgrep` | Exact/regex content search (default `viking://resources/`) |
| `memglob` | File enumeration by glob pattern |
| `memadd` | Add a remote URL or local text file under `viking://resources/` |
| `memremove` | Remove a resource — requires literal `confirm: true` |
| `memqueue` | Observer queue status |
| `memcommit` | Commit the current session and extract persistent memories |

## Behavior notes

- **`memadd`** accepts exactly one destination form — `to` (exact target)
  XOR `parent` (parent directory), both under `viking://resources/`. Local
  uploads are **text files only**; directories are refused with "compress it
  first" guidance. `http(s)` URLs are added as remote resources. Relative
  paths resolve from the calling agent's session cwd.
- **`memremove`** is fail-closed: anything other than the literal
  `confirm: true` is refused.
- **`memcommit`** without `session_id` flushes the current agent's pending
  history first, then commits the agent's OpenViking session. An explicit
  foreign `session_id` commits only that OpenViking session — the current
  agent's history is not flushed into it.

## Automatic behavior

### Repository context

Direct children of `viking://resources/` are listed (TTL-cached per
`repoContext.cacheTtlMs`) and injected into the prompt so the model knows
what is indexed. Refreshed at mount, queued on `agent/session-start`, and
awaited once per `agent/pre-step`. Failures keep the last successful cache
and emit one deduplicated warning.

### Auto recall

Before each model step, the latest user text searches
`viking://user/memories/`; results are ranked, deduplicated, score-filtered,
and budget-capped into a `<relevant-memories>` block. The block enters model
context through the **context-injection channel** (`openviking:memories`
context provider → a separate user-role context message, shown as a
"上下文注入" row in the Web UI) — the user's own message is never modified.
Recall is one-shot per user message, with a per-agent cache. Because injected
context has `source.kind` ≠ `user`, it is never mirrored into OpenViking, so
recalled memories cannot be re-extracted as new memories (the sync layer also
strips any embedded `<relevant-memories>` block defensively).

### Session sync

Real user messages and assistant replies are mirrored into an OpenViking
session whose id equals `String(agent.id)` (created on first need).
Plugin-injected context, runtime context, and tool results are never
mirrored. Message stable ids dedupe; the log drains in seq order and retries
from the earliest gap after failures.

### Auto commit

Every 60 seconds, sessions with uncommitted messages older than
`autoCommit.intervalMinutes` are drained and committed. In-flight commits are
polled on later ticks; failures keep the uncommitted set for retry.

## State file

`stateFile` (`~/.dsh/openviking/state.json` by default) stores message-id
sets, commit timestamps, and pending-commit snapshots — **never message
bodies, API keys, or service responses**. Writes are atomic (`.tmp` +
rename). If the configured endpoint/account/user/agentId identity changes,
the old file is renamed to `.identity-mismatch-<timestamp>` and sync restarts
fresh; unreadable or malformed files are quarantined as
`.corrupt-<timestamp>`.

Transport semantics are **at-least-once**: a crash between a successful
remote message append and the atomic state write may replay that one message
on recovery. Normal exit, HMR, and controlled shutdown close the window via
the plugin disposer's flush.
