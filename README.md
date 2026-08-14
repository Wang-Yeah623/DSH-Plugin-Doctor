# DSH Plugin Doctor

`dsh-plugin-doctor` audits DeepSeek Harness npm Bundles before they reach a real Profile. It validates the Bundle manifest, scans risky behavior, installs into a temporary `DSH_HOME`, boots the Web Profile, produces machine- and human-readable reports, and can install with automatic Profile rollback.

The implementation follows the official [DSH quickstart](https://deepseek-harness.github.io/deepseek-harness/guide/quickstart) and [Bundle publishing guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md).

DeepSeek Harness is in Developer Preview. Doctor therefore records the exact Node, DSH, Cordis/peer dependency and operating-system evidence instead of treating one successful run as permanent compatibility.

## What v0.1 checks

- `package.json`, `dsh.bundle.patch`, published `files`, YAML patch syntax and Cordis rows
- Node engine, DSH compatibility declaration, Cordis and all peer dependency ranges
- package lifecycle scripts, Cordis hooks, shell/process execution, filesystem reads/writes, network access, credential access, dynamic code and native modules
- temporary-Home installation with `dsh plugin --profile web add ... --ignore-scripts`
- composed configuration before/after installation and real Web startup on loopback
- JSON, Markdown, SVG compatibility badge and a DSH regression matrix
- team allowlists, scoped private registries and per-package permission grants

The static scanner is deliberately explainable: every finding includes a file, line, evidence, permission and confidence. It is a review aid, not a proof that unflagged code is safe.

## Install and use

DSH itself currently requires Node `^22.19 || >=24`; Node 24 is recommended when running isolated checks.

```sh
npm install -g dsh-plugin-doctor

# Local checkout, full isolated test against the DSH on PATH
dsh-plugin-doctor check .

# Published or private npm package, tested against several DSH releases
dsh-plugin-doctor check @acme/dsh-tools \
  --dsh-version 0.1.0-rc.2 \
  --dsh-version 0.1.0-rc.3 \
  --dsh-version 0.1.0-rc.6

# Strict mode also blocks unacknowledged high-risk permissions
dsh-plugin-doctor check . --strict --allow-permission hooks

# Audit, isolate-test, install into the real Profile, then boot-test it
dsh-plugin-doctor install @acme/dsh-tools --profile web

# Restore the latest saved Profile snapshot
dsh-plugin-doctor rollback --profile web
```

Reports are written to `reports/` by default:

```text
reports/
├── acme-dsh-tools.doctor.json
├── acme-dsh-tools.doctor.md
└── acme-dsh-tools.badge.svg
```

## Safety model

Acquisition uses `npm pack --ignore-scripts`, so static inspection does not execute the target package. Isolated and real installs also pass `--ignore-scripts` by default. A plugin requiring a git `prepare`, `preinstall`, `install`, or `postinstall` script receives the critical `install-script` permission and is blocked until it is explicitly acknowledged:

```sh
dsh-plugin-doctor check github:acme/plugin#<commit> \
  --allow-scripts \
  --allow-permission install-script
```

`--allow-scripts` means package code can run outside the agent sandbox during package-manager installation. A temporary `DSH_HOME` protects Profile state; it is not an operating-system sandbox. CI or an ephemeral VM/container is recommended for packages with installation scripts or native code.

The Web startup probe binds only to `127.0.0.1` on a temporary port, runs from an empty temporary workspace, strips inherited credentials from the plugin runtime, and disables DSH telemetry. Registry credentials are retained only for the package-manager step, where lifecycle scripts remain disabled by default. Captured output is redacted for common token and authorization patterns.

## Installation and rollback

`install` performs the full isolated check first. When it passes, Doctor:

1. resolves `$DSH_HOME` (`DSH_HOME`, otherwise `~/.dsh`);
2. snapshots `$DSH_HOME/profiles/<profile>` under `$DSH_HOME/.plugin-doctor/backups/`;
3. runs the official `dsh plugin --profile <profile> add <package>` path;
4. composes the Profile and starts Web when the target is `web`;
5. restores the snapshot automatically on any install, composition or startup failure.

The failed post-install Profile is preserved beside the real Profile as `*.failed-<timestamp>` for diagnosis. Successful installs keep their backup for one-command rollback.

## Team policy, private registries and allowlist

Generate a starting policy:

```sh
dsh-plugin-doctor init
```

The resulting `.dsh-doctor.json` supports:

```json
{
  "policy": {
    "blockSeverities": ["critical"],
    "allowedPermissions": [],
    "packagePermissions": {
      "@acme/*": ["hooks", "network"]
    }
  },
  "allowlist": [
    { "package": "@acme/*", "owner": "platform-security" },
    "github:acme/*"
  ],
  "registries": {
    "@acme": "https://npm.acme.internal"
  }
}
```

Authentication remains with npm (`.npmrc`, `NODE_AUTH_TOKEN`, OIDC or the runner's configured credentials). Doctor passes registry selection to npm but never parses or copies credential files into reports.

When an allowlist is non-empty, packages that do not match it are blocked. Package permission rules acknowledge only the named capabilities; new capabilities introduced by an update remain visible and subject to policy.

## GitHub Actions

This repository provides a composite action in [`action.yml`](action.yml). A release matrix can test each supported OS and DSH version:

```yaml
name: Plugin compatibility
on:
  release:
    types: [published]

jobs:
  doctor:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        dsh: [0.1.0-rc.2, 0.1.0-rc.3, 0.1.0-rc.6]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 24
      - uses: github.com/Xrainsmile/DSH-Plugin-Doctor
        with:
          plugin: .
          dsh-version: ${{ matrix.dsh }}
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: doctor-${{ matrix.os }}-${{ matrix.dsh }}
          path: reports/
```

For private packages, configure npm authentication before the Doctor step. The full working matrix used by this project is in [`.github/workflows/plugin-doctor.yml`](.github/workflows/plugin-doctor.yml).

## Bundle compatibility declaration

The official Bundle minimum remains:

```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

Doctor also recognizes an optional plugin-owned range for regression reporting:

```json
{
  "dsh": {
    "compatibility": {
      "dsh": ">=0.1.0-rc.2 <0.2.0"
    }
  }
}
```

This extra field is Doctor metadata; DSH itself currently consumes `dsh.bundle.patch` and the Profile's ordered `dsh.profile.bundles` list.
