---
name: buildkite-playwright-failures
description: "Analyze Playwright test logs on Buildkite to extract failed-only tests across jobs."
---

# Buildkite Playwright failure extraction

Use this skill when you need a compact, human-readable overview of failing Playwright tests from Buildkite job logs.

This workflow uses the `bkci` CLI. Run `/skill:buildkite-cli` first if `bkci` is not set up yet.

## Quick start (script)

```bash
./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Options:

- `--bkci-path PATH` (default: `bkci` or `$BKCI_BIN`)
- `--error-for TEST_NAME` (fetch error details for a single test)
- `--job-id ID` (required with `--error-for`)
- `--job-url URL` (optional with `--error-for`)
- `--failed-line-row N` (optional with `--error-for`)

## Output

The script always emits JSON and caches summary results under your temp dir (`$TMPDIR/pi-buildkite-playwright-failures`). It refreshes the cache if any Playwright job state changes.

Summary output includes:

- `summary`
- `jobs[]` entries with:
  - `jobName`, `jobId`, `jobUrl`, `label`, `state`
  - `failedLine`, `failedLineRow`
  - `tests` (string list)
  - `testEntries` (objects with `name` + `row`)
  - `error`

Error lookup output (`--error-for`) includes:

- `error.testName`, `error.jobId`, `error.jobUrl`
- `error.matchRow`, `error.startRow`, `error.endRow`
- `error.lines` (array of log lines)
- `meta.checkedAt`

When presenting results to a human, format the summary with:

- failed job count
- unique failing tests count
- tests failing in all environments (label as `all`)
- tests failing in multiple environments
- tests failing in only one environment

## What the script does

- Fetches the build with `bkci --raw builds get`.
- Filters for failed Playwright jobs.
- Fetches each failed job log with `bkci jobs log get`.
- Locates the `X failed` summary section and extracts failed test lines.

## Manual steps (if the script fails)

1) Fetch build details:

```bash
bkci --raw builds get --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

2) Find failed Playwright jobs from `data.jobs[]`.

3) Fetch a job log:

```bash
bkci jobs log get --org ORG --pipeline PIPELINE --build BUILD_NUMBER --job JOB_ID
```

4) Extract failed test lines under the `X failed` section.

## Notes

- `bkci jobs log get` returns cleaned logs (ANSI/control sequences stripped) in normalized mode.
- If auth is missing, do not run auth setup automatically. Ask the user to run `bkci auth setup` manually.
