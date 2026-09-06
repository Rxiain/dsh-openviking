# Tools & Automatic Behavior

The eleven base `mem*` tools talk HTTP to the OpenViking service. Failures throw —
the model never sees fake `"Error: ..."` success values.

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
playbooks; opt-out via `autoRecall.agentSpaces`). Each bounded search requests
the candidate pool without a server-side score cutoff; local ranking then
combines the OpenViking semantic score with bounded lexical overlap against
the query, deduplicates results, applies `autoRecall.scoreThreshold`, and
budget-caps the selected entries into a `<relevant-memories>` block. This
lets arbitrary exact project terms recover a weak semantic match without
hard-coded identifier formats, while equally weak unrelated results remain
filtered. Recall is deduplicated per user message: one search + one injection
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

#### Procedure-intent recall lane

Operational workflow questions get a dedicated candidate lane so a durable
playbook is not buried under higher-scoring event or entity memories.
Query intent is classified locally — no model call — by Chinese and English
workflow, audit, recovery, compensation, replay, verification, remediation,
diagnosis, migration, and ordered-step signals (e.g. `workflow`, `recover`,
`audit`, `补偿`, `恢复`, `流程`, `步骤`, `怎么做`). Non-procedural queries
keep the ordinary global recall described above.

For a procedural query, the plugin additionally searches procedure-bearing
leaf branches of the cached user-memory tree. A branch is procedure-bearing
when its normalized path contains a stable marker such as `方法论`,
`方法`, `流程`, `playbook`, `method(s)`, `pattern(s)`, `case(s)`,
`runbook`, `workflow(s)`, or `skill(s)` — marker presence only decides lane
eligibility. Branch candidates use the same local semantic-plus-lexical
relevance gate as global candidates. Retrieval is bounded and cancellation-aware:

- branch discovery reads the cached tree (`viking://user/memories/`, up to
  200 nodes, 3 levels, TTL 5 minutes) and keeps at most 16 branches, longest
  path first;
- each branch search gets a 3-second deadline and shares the existing search
  limit (20) and local relevance threshold (`autoRecall.scoreThreshold`);
- a branch that times out, fails, or is cancelled degrades to the remaining
  candidates — a procedure failure never fails the model request.

The best qualifying procedure candidate (deduplicated, score-thresholded) is
reserved **one injected slot** before ordinary general/agent candidates fill
the remaining `autoRecall.limit` capacity; the reserved URI is excluded from
the filler set. One slot is deliberate: it guarantees a playbook without
turning every process question into a memory-only response. If no procedure
candidate meets the threshold, no placeholder is injected and the global
selection is used unchanged. The combined ordered selection still honors the
existing per-item content cap and total token budget — a procedure entry that
cannot fit the budget is omitted rather than exceeding it.

**Non-goals.** The lane never changes OpenViking server taxonomy, schema, or
extractor behavior; it never converts ordinary memories into Skills, does not
replace native Skill retrieval, and adds no persistent local index. A
procedure that does not meet branch-local semantic relevance is not
guaranteed recall. Explicit Skills remain ordinary candidates unless they
live in a procedure-bearing branch; promoting a memory into a reusable
playbook stays a deliberate `memlearn ... skill` decision by
the user or model.

Structured diagnostics for each prepared step record the intent decision,
procedure branch count, qualifying procedure candidate count, selected lane
mix, timeouts, failures, and fallback outcomes (whether a procedural query
ended up with no procedure candidate).

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
