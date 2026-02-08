---
name: buildkite-cli
description: "Use the bkci CLI to query Buildkite builds, logs, artifacts, and token scope status with LLM-friendly JSON output."
---

# Buildkite CLI (`bkci`)

Use this skill when you want CI data from Buildkite through the `bkci` utility.

This is a good default when you need structured JSON output that is easy for agents to parse.

## Install from local checkout

For now, install from a local clone and link it:

```bash
git clone https://github.com/PSPDFKit-labs/buildkite-cli <buildkite-cli-dir>
cd <buildkite-cli-dir>
pnpm install
pnpm run build
npm link
```

Verify:

```bash
bkci --help
```

After pulling updates, rebuild:

```bash
pnpm run build
```

## Authentication

Set one of these env vars before calling `bkci`:

- `BUILDKITE_TOKEN`
- `BUILDKITE_API_TOKEN`
- `BK_TOKEN`

If no env token is set, auth can be configured interactively:

```bash
bkci auth setup
```

This writes `~/.config/buildkite-cli/auth.json` with strict permissions.

### Agent safety rule

- Do **not** run `bkci auth setup` automatically.
- If `bkci auth status` reports missing token/auth, stop and ask the user to run auth setup manually.
- Do **not** pass token values in command arguments unless the user explicitly requests it.

Required scopes:

- `read_builds`
- `read_build_logs`
- `read_artifacts`

Validate token/scopes first:

```bash
bkci auth status
```

## Common commands

List builds:

```bash
bkci builds list --org ORG --pipeline PIPELINE --per-page 10
```

Get one build with jobs:

```bash
bkci builds get --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Fetch one job log (cleaned output):

```bash
bkci jobs log get --org ORG --pipeline PIPELINE --build BUILD_NUMBER --job JOB_ID --tail-lines 400 --max-bytes 250000
```

List artifacts:

```bash
bkci artifacts list --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Download artifact(s):

```bash
bkci artifacts download --org ORG --pipeline PIPELINE --build BUILD_NUMBER --artifact-id ARTIFACT_ID --out /tmp/bk-artifacts
```

List annotations:

```bash
bkci annotations list --org ORG --pipeline PIPELINE --build BUILD_NUMBER
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

1. `auth status` (if this fails due to missing token/scopes, ask user to fix auth before continuing)
2. `builds list` (optionally filtered by `--pipeline`, `--branch`, `--state`)
3. `builds get` for the selected build
4. `jobs log get` for relevant job IDs
5. `artifacts list` / `artifacts download`
6. `annotations list`
