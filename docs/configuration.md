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
| `autoRecall.scoreThreshold` | `0.15` | Minimum score for filler memories; `0`–`1` |
| `autoRecall.maxContentChars` | `500` | Per-memory content cap; `100`–`5000` |
| `autoRecall.tokenBudget` | `2000` | Injection budget ≈ `tokenBudget * 4` chars; `100`–`10000` |
| `autoCommit.enabled` | `true` | Periodically commit sessions with uncommitted messages |
| `autoCommit.intervalMinutes` | `10` | Minimum minutes between automatic commits; at least `1` |

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
    autoCommit:
      enabled: true
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
