# skills

A shared collection of skills and extensions for AI coding agents.

## What's included

### Skills

Skills are agent-agnostic markdown instructions compatible with any AI coding agent that supports loading markdown context. See [Setup](#setup) for how to wire them up.

- [`buildkite-cli`](skills/buildkite-cli/) — use the local `bkci` CLI for LLM-friendly Buildkite JSON (builds, logs, artifacts, auth scopes).
- [`buildkite-mcp`](skills/buildkite-mcp/) *(deprecated)* — legacy mcporter/mcp-remote Buildkite access kept for compatibility.
- [`buildkite-playwright-failures`](skills/buildkite-playwright-failures/) — extract failed-only Playwright tests from Buildkite logs.
- [`gh-address-comments`](skills/gh-address-comments/) — fetch PR review comments, apply fixes with build verification, and commit each fix atomically. *(Derived from [skills.sh](https://skills.sh/openai/skills/gh-address-comments), Apache 2.0)*
- [`github`](skills/github/) — use the `gh` CLI for issues, PRs, and runs.
- [`github-repo-search`](skills/github-repo-search/) — search any repo via `gh search` and deep-read files via the GitHub API without cloning.
- [`multi-review`](skills/multi-review/) — multi-model PR review workflow.
- [`tmux`](skills/tmux/) — drive tmux sessions for interactive tools.

### Extensions

Extensions are TypeScript plugins that run inside **pi** only and are not compatible with other agents.

- [`buildkite-failures`](extensions/buildkite-failures.ts) — `/bk-playwright-errors <url>` shows a selectable list of failing Playwright tests and opens the Buildkite job in a browser.
- [`cronjob`](extensions/cronjob.ts) — `/cron` command for scheduled prompts (cron expressions), optional job names, and queued runs while busy.
- [`loop`](extensions/loop.ts) — `/loop` command that keeps a follow-up loop running until a breakout condition is met.
- [`notify`](extensions/notify.ts) — desktop notification when the agent finishes and waits for input.
- [`start-design-plan`](extensions/start-design-plan/) — Claude-style design workflow with `/start-design-plan` and `/resume-design-plan`, plus `ask_user_question` and `design_plan_tracker` tools. Ported from concepts in `ed3d-plan-and-execute` (`https://github.com/ed3dai/ed3d-plugins`). Extension-specific license in `extensions/start-design-plan/LICENSE`.
- [`pi-skills-update-checker`](extensions/pi-skills-update-checker.ts) — checks for new commits on startup and shows a widget when updates are available.

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/PSPDFKit-labs/pi-skills ~/dev/skills
```

Keep it somewhere stable — your symlinks and references will point here. Pull to update:

```bash
cd ~/dev/skills && git pull
```

### 2. Wire up your agent

Each `SKILL.md` is a standalone markdown file. How you expose it depends on your agent:

#### Slash commands — Claude Code, Cursor, Windsurf

Agents that support custom slash commands load them from a directory of markdown files. Symlink individual skills there so updates are picked up automatically:

```bash
# Claude Code
mkdir -p .claude/commands
ln -s ~/dev/skills/skills/github/SKILL.md .claude/commands/github.md
ln -s ~/dev/skills/skills/multi-review/SKILL.md .claude/commands/multi-review.md

# Cursor / Windsurf (adjust path to match your agent)
mkdir -p .cursor/rules
ln -s ~/dev/skills/skills/github/SKILL.md .cursor/rules/github.md
```

#### Skills directory — Codex and others

Agents that scan a skills directory (e.g. Codex reads `.agents/skills/`) can use a single symlink for all skills:

```bash
# Codex
ln -s ~/dev/skills/skills .agents/skills

# Claude Code also supports a skills folder
ln -s ~/dev/skills/skills .claude/skills
```

#### Context / memory files — Claude Code

Claude Code supports `@path` imports in `CLAUDE.md` to pull in skill content at startup:

```markdown
<!-- in CLAUDE.md -->
@~/dev/skills/skills/github/SKILL.md
@~/dev/skills/skills/multi-review/SKILL.md
```

For other agents (e.g. Codex's `AGENTS.md`), paste the skill content directly or use the skills directory approach above.

#### Direct prompt reference

For one-off use, just tell your agent where to find the skill:

```
Follow the instructions in ~/dev/skills/skills/multi-review/SKILL.md
```

#### pi — package install

pi treats this repo as a local package. Install it once per project (writes a `.pi/settings.json` entry):

```bash
pi install -l ~/dev/skills
```

Or install directly from GitHub without cloning first:

```bash
pi install -l https://github.com/PSPDFKit-labs/pi-skills
```

Or add it manually to `.pi/settings.json`:

```json
{
  "packages": [
    "/absolute/path/to/pi-skills"
  ]
}
```

Once installed, pi automatically loads all skills from `skills/` and all extensions from `extensions/`. Skills appear as slash commands; extensions register hooks and tools on session start.

To update, pull the repo and run `/reload` in pi to pick up the changes without restarting:

```bash
cd ~/dev/skills && git pull
# then in pi:
/reload
```

## Layout

- `skills/` — each skill in its own folder with a `SKILL.md`.
- `extensions/` — TypeScript extensions loaded by pi.

## Adding content

1. Add a new folder under `skills/` or a new `.ts` file under `extensions/`.
2. Update this README to list it.
3. Commit the change.
