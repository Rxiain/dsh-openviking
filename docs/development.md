# Development, Testing & Publishing

## Build and test

```bash
npm install
npm run build      # tsc → lib/
npm test           # build + node --test test/*.test.mjs (hermetic, no service)
```

The suite covers the HTTP client (auth headers, secret hygiene, abort/timeout
cleanup, envelope unwrapping), the eleven tools (parameter→endpoint/body
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
browser (`WEB_SETTINGS_NAMESPACES`, hard-coded in rc.6). The plugin ships a
loopback-only settings bridge instead of patching anything:

- `src/bridge-protocol.ts` — dependency-free protocol shared by both halves
  (route prefix, wire views, error envelopes). The browser bundle imports it
  without dragging in host runtime dependencies.
- `src/settings-bridge.ts` — host half: `makeBridgeRoutes` registers two
  exact routes (`/api/dsh-openviking/describe`, `/mutate`) on `ctx.webServer`
  (mounted only when a settings service AND a web server are present, so
  headless profiles never see it). Handlers ride `ctx.settings` with the
  official redaction, revision fencing and validation; refusals mirror the
  official RPC codes (`settings-not-exposed`, `settings-conflict`,
  `settings-rejected`). `isLoopbackRequest` gates socket address + Host
  header + origin + `sec-fetch-site`.
- `src/client-ui/compat-scope.ts` — browser half: `createCompatScope` wraps
  the official `ctx.settingsScope`; when it reports the namespace
  `unavailable` on a loopback connection, a `BridgeScopeController` takes
  over and serves the same `SettingsScope` contract from the bridge routes,
  including an optional batch `mutate` so a card save stays atomic. Remote
  browsers never use the bridge.
