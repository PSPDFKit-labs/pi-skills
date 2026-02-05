---
name: buildkite-mcp
description: "Use mcporter with mcp-remote to access Buildkite MCP for builds, jobs, and logs when direct OAuth is flaky."
---

# Buildkite MCP via mcporter + mcp-remote

Use this skill to access Buildkite data through the Buildkite MCP server using `mcp-remote` as a stdio proxy. This avoids flaky direct OAuth flows.

## Setup

1) **Add the server (home scope)**
```bash
mcporter config add buildkite-remote \
  --command "npx" \
  --arg "-y" \
  --arg "mcp-remote@latest" \
  --arg "https://mcp.buildkite.com/mcp" \
  --arg "--transport" \
  --arg "http-only" \
  --arg "--auth-timeout" \
  --arg "60" \
  --arg "--host" \
  --arg "127.0.0.1" \
  --description "Buildkite MCP via mcp-remote" \
  --scope home
```

Use `--scope project` if you want the server stored in `config/mcporter.json` for just the current repo.

2) **Authenticate (browser flow)**
```bash
mcporter auth buildkite-remote
```

Keep the CLI open after the browser says “auth succeeded.” The callback hits `127.0.0.1`, so the CLI must run on the same machine as the browser.

If you see `OAuth error: invalid_request`, clear cached state and retry:
```bash
mcporter auth buildkite-remote --reset
```

3) **Verify auth**
```bash
mcporter call 'buildkite-remote.access_token()' --output json
```

4) **Confirm the server and schema**
```bash
mcporter list buildkite-remote --schema
```

## Common calls

Fetch a build and list jobs (use function-call syntax so build numbers stay strings):
```bash
mcporter call 'buildkite-remote.get_build(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", detail_level: "full")' --output json
```

Search a job log (reverse search with context):
```bash
mcporter call 'buildkite-remote.search_logs(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", job_id: "JOB_ID", pattern: "\\bfailed\\b", reverse: true, limit: 80, context: 3)' --output json
```

Read a focused slice of the log:
```bash
mcporter call 'buildkite-remote.read_logs(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", job_id: "JOB_ID", seek: SEEK, limit: 100)' --output json
```

## Notes

- Use `--output json` so you can script the results.
- Adjust `--auth-timeout` or `--transport` if the remote flow is slow.
