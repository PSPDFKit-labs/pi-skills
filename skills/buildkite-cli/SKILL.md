---
name: buildkite-cli
description: "Use the bkci CLI to query Buildkite builds, logs, artifacts, and token scope status with LLM-friendly JSON output."
---

# Buildkite CLI (`bkci`)

Use this skill when you want CI data from Buildkite through the `bkci` utility.

This is a good default when you need structured JSON output that is easy for agents to parse.

## Install from GitHub (tagged)

Install globally from the tagged GitHub ref:

```bash
npm install -g github:PSPDFKit-labs/buildkite-cli#v0.0.2
```

Alternative with pnpm:

```bash
pnpm add -g github:PSPDFKit-labs/buildkite-cli#v0.0.1
```

Verify:

```bash
bkci --help
```

## Authentication

Set one of these env vars before calling `bkci`:

- `BUILDKITE_TOKEN`
- `BUILDKITE_API_TOKEN`
- `BK_TOKEN`

Or set up local auth config interactively:

```bash
bkci auth setup
```

This writes `~/.config/buildkite-cli/auth.json` with strict permissions.
For non-interactive runs, use:

```bash
bkci auth setup --token "$BUILDKITE_TOKEN"
```

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

1. `auth status`
2. `builds list` (optionally filtered by `--pipeline`, `--branch`, `--state`)
3. `builds get` for the selected build
4. `jobs log get` for relevant job IDs
5. `artifacts list` / `artifacts download`
6. `annotations list`
