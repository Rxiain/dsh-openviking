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
| `memlearn` | Deliberately capture a reusable lesson (dedupe-merge into an existing memory) or mint/update a skill playbook |

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

- **`memlearn`** is the deliberate learning channel (ported from oh-my-pi's
  `learn` tool). It routes by capability (OpenViking 0.4.13 wire layout, the
  current release on PyPI — 0.3.x git checkouts expose a different
  `/api/v1/resources/skills` path):
  - `skill` → `GET /api/v1/skills/<name>` probes existence, then
    `POST /api/v1/skills` mints a new playbook or
    `PUT /api/v1/skills/<name>` replaces an existing one (the service keeps a
    rollback backup and restores it on failure). Skills live under the user
    scope (`viking://user/<user>/skills/<name>/`), get an auto-generated L1
    overview and are vector-indexed.
  - `target` → appends to an explicit existing memory file via
    `POST /api/v1/content/write` (the service preserves the `MEMORY_FIELDS`
    metadata block and re-embeds the file).
  - neither → semantic dedupe: the top `viking://user/memories/` hit at or
    above `min_score` (default 0.5) is appended to; below threshold or empty
    results return `no-match` with actionable guidance instead of a fake
    write (OpenViking has no create-memory endpoint — new memories come from
    session commits).
  Lessons are redacted for common secret shapes before anything touches the
  wire, and on success the lesson is deferred into the current agent turn as
  plugin-sourced context (`source.kind` `plugin`), so it takes effect
  immediately and is never mirrored back or re-extracted.

## Automatic behavior

### Repository context

Direct children of `viking://resources/` are listed (TTL-cached per
`repoContext.cacheTtlMs`) and injected into the prompt so the model knows
what is indexed. Refreshed at mount, queued on `agent/session-start`, and
awaited once per `agent/pre-step`. Failures keep the last successful cache
and emit one deduplicated warning.

### Auto recall

Before each model step, the latest user text searches both
`viking://user/memories/` (preferences/entities/events) and the agent space
`viking://agent/` (cases/patterns/tools/skills memories and shared skill
playbooks; opt-out via `autoRecall.agentSpaces`); results are ranked,
deduplicated, score-filtered, and budget-capped into a `<relevant-memories>`
block. Recall is deduplicated per user message: one search + one injection
per message, later tool steps of the same message neither re-search nor
re-inject. For long tasks, `autoRecall.refreshSteps` (default 10) re-searches
mid-message every N steps and injects only memories that were not shown
before, so memories written during the task (memlearn/memcommit) still get
picked up — at the cost of one search per refresh, never per step. The block enters model
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

Sessions are committed on an oh-my-pi-style rhythm: every 60 seconds the
scheduler drains and commits sessions that accumulated `autoCommit.turns`
(default 3) uncommitted **user turns** — memory follows conversation beats,
not wall-clock. `autoCommit.intervalMinutes` remains as a wall-clock fallback
for sessions that committed before; a never-committed session always waits
for the turn trigger. In-flight commits are polled on later ticks; failures
keep the uncommitted set for retry.

### Session-start memory map

On `agent/session-start` the plugin builds a one-shot `<memory-library>`
block (category counts + retrieval guidance, from `/api/v1/stats/memories`)
injected through the context-injection channel — an oh-my-pi style Memory
Guidance. It orients the agent about what the library holds without
injecting full memories before any question exists; details are fetched on
demand via `memsearch`/`memfind`/`memread`. Cadence is configurable with
`autoRecall.startupMapEveryTurns`: the map is injected at session start and
refreshed every N user turns (`1` = session start only, `0` = never).

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
