---
name: gh-address-comments
description: Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in.
metadata:
  short-description: Address comments in a GitHub PR review
---

# PR Comment Handler

Guide to find the open PR for the current branch and address its comments with gh CLI. Run all `gh` commands with elevated network access.

Prereq: ensure `gh` is authenticated (for example, run `gh auth login` once), then run `gh auth status` with escalated permissions (include workflow/repo scopes) so `gh` commands succeed. If sandboxing blocks `gh auth status`, rerun it with `sandbox_permissions=require_escalated`.

## 1) Inspect comments needing attention
- Run scripts/fetch_comments.py which will print out all the comments and review threads on the PR

## 2) Ask the user for clarification
- Number all the review threads and comments and provide a short summary of what would be required to apply a fix for it
- Ask the user which numbered comments should be addressed

## 3) If user chooses comments
- Address each selected comment **one at a time**, in order
- For each comment:
  1. Apply the code fix
  2. **Build & verify** before committing:
     - Detect the project type and run the appropriate build/test commands:
       - **iOS/Swift/Xcode:** Prefer **Xcode MCP** first, then **XcodeBuildMCP**, and fall back to `xcodebuild` CLI only if neither MCP is available. Build the relevant scheme/target, then run tests.
       - **Node/JS/TS:** `npm run build` / `yarn build`, then `npm test` / `yarn test`
       - **Make-based:** `make`, then `make test`
       - Or whatever build/test setup the project uses
     - At minimum, run tests covering the changed files
     - If the build or tests fail, fix the issue before proceeding — do not commit broken code
  3. Stage only the affected files with `git add <files>`
  4. Commit with a message that:
     - Summarizes the change on the first line (e.g. `Fix null check in parseConfig as requested in review`)
     - Includes a blank line, then a short explanation of **what the reviewer asked for** and **what was changed to address it**
     - References the review thread if possible (e.g. the file path and line number from the thread)
  5. Move on to the next comment
- After all selected comments are addressed, show a summary of all commits made

## 4) Post-run summary
- List each commit (hash + message) created during this session
- Ask the user if they want to push the branch

Notes:
- If gh hits auth/rate issues mid-run, prompt the user to re-authenticate with `gh auth login`, then retry.
