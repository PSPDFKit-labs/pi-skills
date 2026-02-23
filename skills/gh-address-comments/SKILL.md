---
name: gh-address-comments
description: Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in.
metadata:
  short-description: Address comments in a GitHub PR review
---

# PR Comment Handler

Guide to find the open PR for the current branch and address its comments with gh CLI. Run all `gh` commands with elevated network access.

Prereq: ensure `gh` is authenticated (for example, run `gh auth login` once), then run `gh auth status` with escalated permissions (include workflow/repo scopes) so `gh` commands succeed. If sandboxing blocks `gh auth status`, rerun it with `sandbox_permissions=require_escalated`.

`<skill-root>` means the directory containing this `SKILL.md`.

## 1) Inspect comments needing attention
- Run `python3 <skill-root>/scripts/fetch_comments.py` while keeping the current working directory in the PR repository so `gh pr view` resolves the correct PR
- From the output, focus on **unresolved** review threads (`"isResolved": false`) and top-level conversation comments that haven't been answered yet
- Discard resolved threads and outdated threads unless they contain unanswered follow-ups

## 2) Ask the user for clarification
- Number all unresolved review threads and unanswered comments
- For each, provide:
  - The **file and line** (for inline threads)
  - A short summary of the feedback
  - A **category**:
    - **Actionable** — Code change, fix, or improvement needed
    - **Question** — Reviewer is asking for clarification, no code change needed
    - **Discussion** — Opinion/preference, assess if change improves code
    - **Already addressed** — Change was already made but thread wasn't resolved
    - **Follow-up** — Valid improvement but out of scope for this PR
    - **Reaction-only** — No code or explanation needed; acknowledge with a reaction only
- Ask the user which numbered comments should be addressed

## 3) If user chooses comments
- Address each selected comment **one at a time**, in order
- For each comment:
  1. Apply the code fix (for actionable items), prepare a text reply (for question/discussion/already-addressed/follow-up), or mark as reaction-only
  2. **Build & verify** before committing (skip for all no-code-change categories, including reaction-only):
     - Detect the project type and run the appropriate build/test commands:
       - **iOS/Swift/Xcode:** Prefer **Xcode MCP** first, then **XcodeBuildMCP**, and fall back to `xcodebuild` CLI only if neither MCP is available. Build the relevant scheme/target, then run tests.
       - **Node/JS/TS:** `npm run build` / `yarn build`, then `npm test` / `yarn test`
       - **Make-based:** `make`, then `make test`
       - Or whatever build/test setup the project uses
     - At minimum, run tests covering the changed files
     - If the build or tests fail, fix the issue before proceeding — do not commit broken code
  3. **If code changed for this comment**:
     - Stage only the affected files with `git add <files>`
     - Commit with a message that:
       - Summarizes the change on the first line (e.g. `Fix null check in parseConfig as requested in review`)
       - Includes a blank line, then a short explanation of **what the reviewer asked for** and **what was changed to address it**
     - **Push the commit** (`git push`) so the sha is live on GitHub before replying
  4. **If no code changed** (e.g. question/discussion/already-addressed/follow-up/reaction-only):
     - Skip `git add`, `git commit`, and `git push`
  5. **If category is Reaction-only**, add a reaction to the relevant comment and do not post a text reply:
     - Use the target comment's GraphQL node id from fetched data as `<COMMENT_NODE_ID>`
     ```bash
     gh api graphql \
       -f query='mutation($subjectId: ID!) {
         addReaction(input: {
           subjectId: $subjectId
           content: THUMBS_UP
         }) {
           reaction { content }
         }
       }' \
       -F subjectId='<COMMENT_NODE_ID>'
     ```
  6. **For categories requiring a text response** (Actionable/Question/Discussion/Already addressed/Follow-up), route by comment type and pass response body safely:
     - Create a temp file to avoid shell-escaping issues in `<response>`:
       ```bash
       printf '%s' "<response>" > /tmp/pr-feedback-response.txt
       ```
     - **If the item is an inline review thread** (has `<THREAD_ID>`), reply via GraphQL mutation:
       ```bash
       gh api graphql \
         -f query='mutation($threadId: ID!, $body: String!) {
           addPullRequestReviewThreadReply(input: {
             pullRequestReviewThreadId: $threadId
             body: $body
           }) {
             comment { id }
           }
         }' \
         -F threadId='<THREAD_ID>' \
         -F body=@/tmp/pr-feedback-response.txt
       ```
     - **If the item is a top-level PR conversation comment** (from `conversation_comments`), post a PR conversation comment:
       ```bash
       gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
         -X POST \
         -F body=@/tmp/pr-feedback-response.txt
       ```
     - **Only if needed** (e.g. thread reply mutation fails and you have `<comment_id>`), fallback to inline comment reply endpoint:
       ```bash
       gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{comment_id}/replies \
         -X POST \
         -F body=@/tmp/pr-feedback-response.txt
       ```
     - Optional cleanup when done with this reply:
       ```bash
       rm -f /tmp/pr-feedback-response.txt
       ```
  7. Use the appropriate **response format** based on category:
     - **Actionable**: "Fixed in `<sha>`. <brief explanation of the change>"
     - **Question**: "<answer with code references if helpful>"
     - **Discussion**: "Good point. <explanation — either made the change or explained why not>"
     - **Already addressed**: "This was already addressed. <brief explanation; include `<sha>` if known>"
     - **Follow-up**: "Created #<issue> to track this — out of scope for this PR."
     - **Reaction-only**: Add a reaction only (no textual reply)
  8. Move on to the next comment

- For comments the user chose **not** to address:
  - If the user requested **reaction-only acknowledgment**, add a reaction and do not post a text reply
  - Otherwise, reply explaining why (e.g. over-engineering, not applicable, etc.) using the same routing rules as Step 6 so the reviewer knows their feedback was considered

- **Follow-up issues**: For any item categorized as **Follow-up** (valid but out of scope), create a GitHub issue:
  ```bash
  gh issue create \
    --title "<concise description>" \
    --body "## Context
  Identified during review of #<PR_NUMBER>.

  ## Reviewer feedback
  > <quote the comment>

  ## Proposed approach
  <brief description>

  ## Related
  - PR: #<PR_NUMBER>
  - Comment: <link to the review comment>"
  ```
  Then reply on the thread referencing the new issue number.

- After all comments are handled, show a summary of all commits made

## 4) Post-run summary
- List each commit (hash + message) created during this session
- List any follow-up issues created (number + title + link)
- List threads that were handled without code changes (questions, discussions, already-addressed, follow-up)
- List reaction-only acknowledgments added (comment/thread reference + reaction)
- Confirm that all actionable commits were pushed before their corresponding thread replies

Notes:
- If gh hits auth/rate issues mid-run, prompt the user to re-authenticate with `gh auth login`, then retry.
