---
name: github-repo-search
description: Search a specific GitHub repository for code using gh search and fetch file contents via gh api without cloning. Use when given a repo URL and query to locate logic in remote repos.
---

# GitHub Repo Search (No Clone)

Use this skill to locate code in a specific GitHub repo by URL, summarize matches, and deep-read a chosen file via the GitHub API.

## Requirements

- `gh` CLI installed and authenticated (`gh auth status`).
- Network access to GitHub.

## Inputs to Collect

- **Repo URL** (e.g. `https://github.com/OWNER/REPO`)
- **Search query** (the string or pattern to search)

If any input is missing, ask the user.

## Workflow

1. **Parse repo**
   - Extract `OWNER` and `REPO` from the URL.

2. **Search code in the repo**
   - Run:
     ```bash
     gh search code --repo OWNER/REPO "<query>"
     ```
   - Prefer JSON output for structured parsing:
     ```bash
     gh search code --repo OWNER/REPO "<query>" --json path,repository,sha,url,textMatches
     ```

3. **Summarize results**
   - If zero results, report and ask for a refined query.
   - If multiple files match, list them with paths and brief snippets (from `textMatches` if present), then ask which file to **Deep Read**.
   - If a single file matches, proceed to Deep Read confirmation.

4. **Deep Read chosen file**
   - Use the GitHub API to fetch content without cloning:
     ```bash
     gh api repos/OWNER/REPO/contents/<path>
     ```
   - The `content` field is base64. Decode it:
     ```bash
     gh api repos/OWNER/REPO/contents/<path> --jq .content | base64 --decode
     ```
   - **Fallback for large files (~1 MB limit on contents API):**
     - Use the `download_url` from the contents response:
       ```bash
       gh api repos/OWNER/REPO/contents/<path> --jq .download_url | xargs curl -L
       ```
     - Or fetch by blob SHA (from `gh search code --json sha`):
       ```bash
       gh api repos/OWNER/REPO/git/blobs/<sha> --jq .content | base64 --decode
       ```
     - Or request raw content directly:
       ```bash
       gh api repos/OWNER/REPO/contents/<path> -H "Accept: application/vnd.github.raw"
       ```

5. **Present full file**
   - Show the full content and provide a short summary of the logic relevant to the query.

## Usage Example

User request:

> Find where rate limiting is implemented for DWS Processor API in https://github.com/PSPDFKit/PSPDFKit

Run:

```bash
gh search code --repo PSPDFKit/PSPDFKit "DWS Processor API rate limit" --json path,repository,sha,url,textMatches
```

If the user chooses a result like `<path-from-results>`, deep read it:

```bash
gh api repos/PSPDFKit/PSPDFKit/contents/<path-from-results> --jq .content | base64 --decode
```

## Notes

- Do **not** clone the repository unless the user explicitly asks.
- If the file is large, ask whether to show the full file or specific sections.
- Use the default branch unless the user specifies a branch; for a specific ref:
  ```bash
  gh api repos/OWNER/REPO/contents/<path>?ref=<branch-or-sha>
  ```
