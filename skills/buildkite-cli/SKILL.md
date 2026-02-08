---
name: buildkite-cli
description: "Use the bkci CLI to query Buildkite builds, logs, artifacts, and token scope status with LLM-friendly JSON output."
---

# Buildkite CLI (`bkci`)

Use this skill when you want CI data from Buildkite through the `bkci` utility.

This is a good default when you need structured JSON output that is easy for agents to parse.

## Install from GitHub

Use the public repo and install it in any directory (do not assume a machine-specific path):

```bash
BKCI_DIR="${BKCI_DIR:-$HOME/.local/share/buildkite-cli}"

if [ ! -d "$BKCI_DIR/.git" ]; then
  git clone https://github.com/PSPDFKit-labs/buildkite-cli "$BKCI_DIR"
fi

cd "$BKCI_DIR"
pnpm install
pnpm run build
```

## Running the CLI

From the clone directory:

```bash
node dist/index.js ...
```

or:

```bash
pnpm exec tsx src/index.ts ...
```

If `bkci` is already on `PATH`, you can call it directly.

## Authentication

Set one of these env vars before calling `bkci`:

- `BUILDKITE_TOKEN`
- `BUILDKITE_API_TOKEN`
- `BK_TOKEN`

Required scopes:

- `read_builds`
- `read_build_logs`
- `read_artifacts`

Validate token/scopes first:

```bash
node dist/index.js auth status
```

For local 1Password usage, this is commonly used:

```bash
export BUILDKITE_TOKEN="$(op read 'op://Employee/Buildkite Agent Token/credential')"
```

## Common commands

List builds:

```bash
node dist/index.js builds list --org ORG --pipeline PIPELINE --per-page 10
```

Get one build with jobs:

```bash
node dist/index.js builds get --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Fetch one job log (cleaned output):

```bash
node dist/index.js jobs log get --org ORG --pipeline PIPELINE --build BUILD_NUMBER --job JOB_ID --tail-lines 400 --max-bytes 250000
```

List artifacts:

```bash
node dist/index.js artifacts list --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Download artifact(s):

```bash
node dist/index.js artifacts download --org ORG --pipeline PIPELINE --build BUILD_NUMBER --artifact-id ARTIFACT_ID --out /tmp/bk-artifacts
```

List annotations:

```bash
node dist/index.js annotations list --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

## Output contract

`bkci` always returns a stable top-level JSON envelope:

- `ok`
- `apiVersion`
- `command`
- `request`
- `summary`
- `pagination`
- `data`
- `error`

Use `--raw` to keep exact Buildkite payloads in `data`.

## Recommended usage pattern

1. `auth status`
2. `builds list` (optionally filtered by `--pipeline`, `--branch`, `--state`)
3. `builds get` for the selected build
4. `jobs log get` for relevant job IDs
5. `artifacts list` / `artifacts download`
6. `annotations list`
