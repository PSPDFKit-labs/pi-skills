---
name: buildkite-playwright-failures
description: "Analyze Playwright test logs on Buildkite to extract failed-only tests across jobs."
---

# Buildkite Playwright failure extraction

Use this skill when you need a compact, human-readable overview of failing Playwright tests from Buildkite job logs. This workflow uses the Buildkite MCP server via `mcporter` and `mcp-remote`. Run `/skill:buildkite-mcp` first for setup.

## Quick start (script)

```bash
./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER
```

Options:
- `--server NAME` (default: `buildkite-remote`)
- `--pattern REGEX` (default: `\b\d+ failed\b`)
- `--search-limit N` (default: 80)
- `--context N` (default: 3)
- `--read-limit N` (default: 120)
- `--error-for TEST_NAME` (fetch error details for a single test)
- `--job-id ID` (required with `--error-for`)
- `--job-url URL` (optional with `--error-for`)
- `--failed-line-row N` (optional with `--error-for`)
- `--error-search-limit N` (default: 20)
- `--error-context N` (default: 2)
- `--error-read-limit N` (default: 200)

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

- Fetches the build with `detail_level: "full"`.
- Filters for failed Playwright jobs.
- Searches logs backwards for the summary line (`X failed`).
- Reads a small log slice around the summary line.
- Captures only the failed test lines, stopping before flaky/skipped/passed sections.

## Manual steps (if the script fails)

1) **Fetch the build and collect job IDs**
```bash
mcporter call 'buildkite-remote.get_build(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", detail_level: "full")' --output json
```

2) **Locate the failure summary block**
```bash
mcporter call 'buildkite-remote.search_logs(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", job_id: "JOB_ID", pattern: "\\b\\d+ failed\\b", reverse: true, limit: 80, context: 3)' --output json
```

3) **Read only the failure list**
```bash
mcporter call 'buildkite-remote.read_logs(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", job_id: "JOB_ID", seek: SEEK, limit: 120)' --output json
```

4) **Ignore flaky sections**
- Copy only the lines under the “X failed” section.
- Skip any “flaky” or “skipped” sections that appear later.

## Notes

- Use `--output json` so you can script the results.
- The summary block is usually near the end of the log.
- If it isn’t found in the last ~1,000 lines, increase the seek/limit range and retry.
