# Getting Started

Installation, verification, and configuration-layer semantics for
`dsh-openviking`.

## Prerequisites

- Node.js `^22.19.0 || >=24.0.0` (same range as the Harness root package).
- A DeepSeek Harness profile (created automatically on first `dsh plugin add`).
- A running OpenViking service. Verify it before installing:

  ```bash
  ov health -o json    # expect ok: true, healthy: true
  ```

  This is a user-run diagnostic; the plugin itself never invokes `ov`.

## Install

### From GitHub (recommended)

The repository commits prebuilt `lib/`, so a git install loads without any
build step — no `prepare` script and no build authorization are needed:

```bash
dsh plugin --profile <name> add github:Rxiain/dsh-openviking
```

There is also a one-shot installer in the repo:

```bash
sh install.sh [profile-name]          # default profile: dsh-openviking
```

### From a checkout

```bash
git clone https://github.com/Rxiain/dsh-openviking
cd dsh-openviking
npm install && npm run build          # optional: lib/ is already committed
dsh plugin --profile <name> add .
```

## Verify and run

```bash
dsh --profile <name> --dump-config   # expect exactly one `id: openviking` row
dsh --profile <name>
```

`dsh plugin` installs the package into the profile and appends it to the
profile's bundle layers. The bundle patch inserts one row (`id: openviking`,
package `dsh-openviking`); no base tools are disabled or replaced.

## Uninstall

```bash
dsh plugin --profile <name> remove dsh-openviking
```

## Configuration layers

DeepSeek Harness composes configuration in this order:

1. Base bundle
2. Installed bundles, in add order
3. The profile's own `cordis.patch.yml`
4. `$DSH_HOME/cordis.patch.yml`
5. `--patch` overlays

Later layers win by row. A patch targeting a row replaces that row's
**entire `config` object** — configuration is never deep-merged. To override
any OpenViking setting, restate the complete configuration under the same
`id: openviking` in your profile's `cordis.patch.yml` (or a `--patch`
overlay). See [Configuration](configuration.md) for the full reference and a
complete example patch.
