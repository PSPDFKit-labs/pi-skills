# pi skills (shared)

Shared pi skills and extensions used by the team. Add this repo as a local package in pi to load them.

## What's included

### Skills

- `buildkite-cli` — use the local `bkci` CLI for LLM-friendly Buildkite JSON (builds, logs, artifacts, auth scopes).
- `buildkite-mcp` *(deprecated)* — legacy mcporter/mcp-remote Buildkite access kept for compatibility.
- `buildkite-playwright-failures` — extract failed-only Playwright tests from Buildkite logs.
- `gh-address-comments` — fetch PR review comments, apply fixes with build verification, and commit each fix atomically. *(Derived from [skills.sh](https://skills.sh/openai/skills/gh-address-comments), Apache 2.0)*
- `github` — use the `gh` CLI for issues, PRs, and runs.
- `multi-review` — multi-model PR review workflow.
- `tmux` — drive tmux sessions for interactive tools.

### Extensions

- `buildkite-failures` — `/bk-playwright-errors <url>` shows a selectable list of failing Playwright tests and opens the Buildkite job in a browser.
- `cronjob` — `/cron` command for scheduled prompts (cron expressions), optional job names, and queued runs while busy.
- `loop` — `/loop` command that keeps a follow-up loop running until a breakout condition is met.
- `notify` — desktop notification when the agent finishes and waits for input.
- `start-design-plan` — Claude-style design workflow extension with `/start-design-plan` and `/resume-design-plan`, plus `ask_user_question` and `design_plan_tracker` tools. Ported from concepts in `ed3d-plan-and-execute` (`https://github.com/ed3dai/ed3d-plugins`).

## Usage

Install as a project-local package (writes `.pi/settings.json`):

```bash
pi install -l /absolute/path/to/pi-skills-nutrient
```

Install directly from GitHub:

```bash
pi install -l https://github.com/PSPDFKit-labs/pi-skills
```

Or add it manually:

```json
{
  "packages": [
    "/path/to/pi-skills-nutrient"
  ]
}
```

After pulling updates, run `/reload` in pi to reload extensions, skills, and prompts.

## Layout

- `skills/` — each skill lives in its own folder with a `SKILL.md`.
- `extensions/` — TypeScript extensions loaded by pi.

## Adding content

1. Add a new folder under `skills/` or a new `.ts` file under `extensions/`.
2. Update this README to list it.
3. Commit the change.
