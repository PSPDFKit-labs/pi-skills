# pi skills (shared)

Shared pi skills and extensions used by the team. Add this repo as a local package in pi to load them.

## What's included

### Skills

- `github` — use the `gh` CLI for issues, PRs, and runs.
- `multi-review` — multi-model PR review workflow.
- `tmux` — drive tmux sessions for interactive tools.

### Extensions

- `loop` — `/loop` command that keeps a follow-up loop running until a breakout condition is met.
- `notify` — desktop notification when the agent finishes and waits for input.

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
