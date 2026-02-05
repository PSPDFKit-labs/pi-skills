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

## Downloading artifacts

1) List artifacts for a job and extract the download URL:
```bash
mcporter call 'buildkite-remote.list_artifacts_for_job(org_slug: "ORG", pipeline_slug: "PIPELINE", build_number: "BUILD_NUMBER", job_id: "JOB_ID", page: 1, perPage: 100)' --output json \
  | jq -r '.items[] | [.path, .download_url] | @tsv'
```

2) Attempt direct download via MCP (returns base64 data on success):
```bash
mcporter call 'buildkite-remote.get_artifact(url: "DOWNLOAD_URL")' --output json \
  | jq -r '.data' \
  | base64 --decode > artifact
```

3) If you see `Only one auth mechanism allowed` (S3 rejects the Authorization header), extract the
   presigned S3 URL from the MCP error and download with curl (no auth header):
```bash
DOWNLOAD_URL="https://api.buildkite.com/v2/organizations/ORG/pipelines/PIPELINE/builds/BUILD_NUMBER/jobs/JOB_ID/artifacts/ARTIFACT_ID/download"
S3_URL=$(mcporter call "buildkite-remote.get_artifact(url: \"${DOWNLOAD_URL}\")" --output json \
  | perl -ne 'if (/GET (https:\/\/s3.amazonaws.com[^ ]+)/) { $u=$1; $u=~s/:$//; print $u }')

curl -L "$S3_URL" -o artifact
```

## Notes

- Use `--output json` so you can script the results.
- Adjust `--auth-timeout` or `--transport` if the remote flow is slow.
