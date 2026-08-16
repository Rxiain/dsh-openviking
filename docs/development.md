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

The settings suite (`test/settings.test.mjs`) additionally mounts a real
in-memory settings provider and verifies the `openviking` namespace
registration, layered resolution over the composition entry, live
reconfiguration of request-facing fields, seam-side endpoint validation, and
the browser-half artifact (loader format + canonical `apply`/`inject`).

## Browser half (web UI settings card)

`src/client-ui.tsx` is the plugin's browser half: it registers the OpenViking
card into the dsh web UI's Plugins → Plugin configuration section
(`settings.plugin.item` slot), binds the `openviking` settings namespace via
`ctx.settingsScope`, stages edits, and writes them with revision-fenced
`settings.mutate` path ops. It is built separately because the browser needs
the dsh loader bundle format, not plain ESM:

```bash
npm run build
# 1. tsc -p tsconfig.json            → host lib/*.js (ESM)
# 2. tsc -p tsconfig.client.json     → lib/client-ui.d.ts (types, no JS)
# 3. node scripts/build-client.mjs   → lib/client-ui.js (esbuild CJS +
#                                      window.__ModuleLoader__.load wrapper)
```

The bundle keeps `react`, `react/jsx-runtime` and
`@deepseek-ai/dsh-client-ui-primitives` external; the browser loader
resolves them from its module table. `package.json` declares
`dsh.client` (`platform: "web"`, inject edges) and `exports["./client"]`, so
the web profile's client-module registry serves the bundle at
`/plugins/dsh-openviking/client.js` and the boot manifest loads it.

Host exposure is the only harness-side requirement: the installed
`@deepseek-ai/dsh-host-apiproxy` gates which settings namespaces reach the
browser. `scripts/patch-dsh-exposure.mjs` places a patched copy (with
`openviking` added to `WEB_SETTINGS_NAMESPACES`) in the profile's own
`node_modules`, which the loader resolves before the installation copy.

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
