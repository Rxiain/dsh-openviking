# Configuration

All deployment parameters come from the `config` of the `id: openviking`
Cordis row. The bundle ships working defaults (see `cordis.patch.yml`);
overrides go in the profile's own patch as a **complete** restatement.

## Reference

| Field | Default | Meaning and validation |
| --- | --- | --- |
| `endpoint` | `http://localhost:1933` | OpenViking HTTP base URL |
| `apiKey` | `''` | `X-API-Key` value (empty omits the header) |
| `account` | `''` | `X-OpenViking-Account` tenant header (empty omits it) |
| `user` | `''` | `X-OpenViking-User` header (empty omits it) |
| `agentId` | `deepseek-harness` | `X-OpenViking-Agent` header (empty omits it) |
| `timeoutMs` | `30000` | Per-request timeout; `1000`–`300000` |
| `stateFile` | `~/.dsh/openviking/state.json` | Session-sync state file (`~` expanded) |
| `repoContext.enabled` | `true` | Inject the indexed-repository list into the prompt |
| `repoContext.cacheTtlMs` | `60000` | Repository-list cache TTL; `1000`–`3600000` |
| `autoRecall.enabled` | `true` | Inject relevant memories before each model step |
| `autoRecall.limit` | `6` | Max memories injected per step; `1`–`50` |
| `autoRecall.scoreThreshold` | `0.15` | Minimum local relevance score: OpenViking semantic score plus bounded lexical overlap with the query; `0`–`1` |
| `autoRecall.maxContentChars` | `500` | Per-memory content cap; `100`–`5000` |
| `autoRecall.tokenBudget` | `2000` | Injection budget ≈ `tokenBudget * 4` chars; `100`–`10000` |
| `autoRecall.agentSpaces` | `true` | Also search the agent space (`viking://agent/`) so cases/patterns/tools/skills memories and shared skill playbooks are recalled, not just user-space preferences/entities/events |
| `autoRecall.refreshSteps` | `10` | Re-search mid-message every N tool steps and inject only memories not seen yet (`0` disables); large tasks pick up memories written mid-flight without re-searching every step |
| `autoRecall.startupMapEveryTurns` | `5` | Memory map: injected on session start, then refreshed every N **user turns** (`1` = session start only, `0` = never); long sessions get fresh counts as memories accumulate |
| `autoCommit.enabled` | `true` | Periodically commit sessions with uncommitted messages |
| `autoCommit.turns` | `3` | Commit after this many uncommitted **user turns** (oh-my-pi retain rhythm; `0` disables the turn trigger) |
| `autoCommit.intervalMinutes` | `10` | Wall-clock fallback: flush sessions with uncommitted messages older than this. With `turns>0` a never-committed session still waits for the turn trigger; with `turns=0` (trigger disabled) the interval applies from the start |

Procedure-intent recall (see [`docs/tools.md`](docs/tools.md)) reuses the
`scoreThreshold` / `maxContentChars` / `tokenBudget` / `limit` knobs above
and applies fixed, non-configurable bounds: tree discovery keeps at most 16
procedure-bearing branches with a 5-minute cache TTL, and each branch search
has a 3-second deadline. There are no additional `autoRecall.*` fields for
the procedure lane.

Invalid types and out-of-range values are **rejected at load time** by the
config schema — the plugin never silently clamps.

## Example profile patch

A complete `id: openviking` row with an environment-bound API key:

```yaml
- id: openviking
  config:
    endpoint: 'http://localhost:1933'
    apiKey: !!js process.env.OPENVIKING_API_KEY ?? ''
    account: ''
    user: ''
    agentId: 'deepseek-harness'
    timeoutMs: 30000
    stateFile: '~/.dsh/openviking/state.json'
    repoContext:
      enabled: true
      cacheTtlMs: 60000
    autoRecall:
      enabled: true
      limit: 6
      scoreThreshold: 0.15
      maxContentChars: 500
      tokenBudget: 2000
      agentSpaces: true
      refreshSteps: 10
      startupMapEveryTurns: 5
    autoCommit:
      enabled: true
      turns: 3
      intervalMinutes: 10
```
## Authentication and secrets

For every non-empty configured value, requests carry the corresponding header:

| Config field | HTTP header |
| --- | --- |
| `apiKey` | `X-API-Key` |
| `account` | `X-OpenViking-Account` |
| `user` | `X-OpenViking-User` |
| `agentId` | `X-OpenViking-Agent` |

The API key never appears in errors, logs, or the state file. Prefer an
environment binding over a literal value, and keep
`apiKey`/`account`/`user` out of committed files:

```yaml
apiKey: !!js process.env.OPENVIKING_API_KEY ?? ''
```

## Disabling

There is no plugin-level `enabled` field. Disable the Cordis row:

```yaml
- id: openviking
  disabled: true
```

## Visual configuration in the dsh web UI

When the deployment runs the dsh browser UI (`dsh web`), the OpenViking
settings card appears under **设置 → 插件 → 插件配置**. It edits the same
fields as this document through the user-settings seam (`settings.yaml` at
`$DSH_HOME`), layered over the profile's `id: openviking` row:

- **schema defaults → profile row (composition base) → user document** —
  fields saved in the UI land in `settings.yaml`; fields not saved there
  keep the profile row's value. A field the user layer carries shows an
  "已覆盖 / Overridden" badge with a "恢复默认 / Reset to default" control
  that clears the override (the field re-inherits the profile row).
- **live fields** — `endpoint`, `apiKey`, `account`, `user`, `agentId`,
  `timeoutMs`, `repoContext.*`, `autoRecall.*` and the auto-commit schedule
  apply immediately on save (the plugin re-reads them per request/step).
- **boot fields** — `stateFile` is read once at plugin start; changing it
  takes effect on the next restart.
- **validation** — the schema ranges above are enforced on save; a
  malformed `endpoint` is refused by the settings seam instead of stored.

The card is the plugin's browser half (`dsh.client` + `exports["./client"]`,
built to `lib/client-ui.js`); the host serves it at
`/plugins/dsh-openviking/client.js` in the web profile.

**Exposure.** Pre-0.1.2 host-apiproxies only serve settings namespaces on an
explicit hard-coded allowlist (`WEB_SETTINGS_NAMESPACES`), so the plugin
ships a loopback-only settings bridge (`src/settings-bridge.ts`) instead:
when the web card binds the `openviking` namespace and the official scope
reports it unavailable, the browser half falls back to two same-origin
routes (`POST /api/dsh-openviking/describe` and `/mutate`) that re-serve the
namespace through the host settings seam. The bridge rides `ctx.settings`
(schema validation, revision fencing, persistence and events for free),
serves only the plugin's own registered namespace, and refuses anything that
is not a loopback same-origin POST. No harness patch, no allowlist file, no
re-run after dsh upgrades or `dsh plugin add|remove`.
