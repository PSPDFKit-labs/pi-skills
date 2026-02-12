# start-design-plan extension

Adds a Claude-style `/start-design-plan` workflow to pi without relying on a separate skill.

This extension is a pi port of concepts/workflows from Ed Ropple's `ed3d-plan-and-execute` plugin set:
https://github.com/ed3dai/ed3d-plugins

License for this extension is in `LICENSE` (CC BY-SA 4.0).

## Features

- `/start-design-plan` command
- `ask_user_question` tool for structured choices
- `design_research_fanout` tool for parallel, phase-gated research runs
- `design_plan_tracker` tool for five-phase status tracking
- Progress widget + status line
- Strict guardrail mode for discrete decisions and completion response shape
- Research Digest requirement before architecture-direction questions
- Workflow contract in `assets/workflow.md`

## Tools

### `ask_user_question`

Structured decision tool for discrete options.

Parameters:
- `question`: string
- `options`: array of `{ label, description? }`
- `allowOther?`: boolean (defaults to `true`)
- `otherLabel?`: string

### `design_research_fanout`

Role-based subagent fanout used before clarification and during brainstorming.

Default role packs:
- `context`: `codebase-investigator`, `constraints-analyst`, `external-researcher`
- `brainstorm`: `critical-path-investigator`, `alternatives-analyst`, `industry-researcher`

Parameters:
- `phase`: `context` | `brainstorm`
- `topic`: string
- `goals?`: string[] (custom goals, converted into analyst tasks)
- `roles?`: explicit role assignments (`label`, `role`, `goal`, `mode`, `deliverable?`)
- `includeInternet?`: boolean (optional override of `/design-plan-config`)
- `maxAgents?`: number (1-4, optional override of `/design-plan-config`)
- `model?`: string (optional override of `/design-plan-config`)

### `design_plan_tracker`

State tracker for workflow phases.

Actions:
- `create`
- `get`
- `set_status`
- `append_note`
- `set_design_path`
- `add_task`
- `set_task_status`
- `append_task_note`
- `list_tasks`
- `reset`

## Commands

### `/start-design-plan [topic]`

Starts the five-phase design process and injects the workflow instructions into the conversation.

If no topic is supplied, the command prompts for one.

### `/resume-design-plan [optional guidance]`

Resumes an in-progress design workflow from the stored tracker state.

Optional guidance is passed through as additional instruction for the resumed run.

### `/design-plan-config [status|reset|model <id|default>|max-agents <1-4>|include-internet <on|off>]`

Configures default behavior for research fanout tool calls made during the design workflow.

Configuration is persisted per project at `.pi/design-plan-config.json`.

- With no arguments (interactive UI mode), opens a config menu with a model selector.
- With arguments, supports scriptable text commands.

Defaults:
- `model=default`
- `maxAgents=3`
- `includeInternet=on`

These defaults are automatically applied when the assistant calls `design_research_fanout` without explicit overrides.

### `/design-plan-guardrails [strict|relaxed|status]`

Controls guardrail behavior:
- `strict` (default):
  - enforces `ask_user_question` for discrete 2+ option decisions
  - enforces final completion response shape (`Design planning is complete.` + `Design path: ...`)
- `relaxed`: prompt guidance only
- `status`: show current mode
