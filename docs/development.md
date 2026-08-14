# Development, Testing & Publishing

## Build and test

```bash
npm install
npm run build      # tsc → lib/
npm test           # build + node --test test/*.test.mjs (hermetic, no service)
```

The suite covers the HTTP client (auth headers, secret hygiene, abort/timeout
cleanup, envelope unwrapping), the ten tools (parameter→endpoint/body
mapping, canonical output values, fail-closed removal), auto layers (repo
TTL, recall ranking/budget, session drain ordering/retry, state restore),
and a full Cordis lifecycle harness (real Context spine + fake OpenViking
server: adoption, pre-step injection, dispose revocation, remount).

Real-service contract tests run only when explicitly enabled:

```bash
export OPENVIKING_API_KEY='...'   # injected by the test process
OPENVIKING_INTEGRATION=1 npm test
```

The harness reads endpoint/account from `ov config show -o json`; the API key
# Development, Testing & Distribution
…
## Distribution

The plugin is distributed from the GitHub repository, not npm. The repo
commits prebuilt `lib/` (compiled from `src/`), so installs via
`dsh plugin --profile <name> add github:Rxiain/dsh-openviking` load without
any build step or authorization.

**When you change `src/`**: run `npm run build` and commit the updated `lib/`
alongside the source — otherwise git installers get a stale build. The
package `files` set (`lib`, `cordis.patch.yml`, READMEs, `docs/`) is only
relevant for `npm pack`/tarball installs.

## Contributing

1. Fork the repository and create a feature branch.
2. Make the change; add or update tests.
3. Run the checks: `npm test`.
4. Open a pull request.

Keep changes focused, never commit secrets, and preserve the HTTP-only
design unless a change is explicitly agreed upon.
