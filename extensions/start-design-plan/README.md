# start-design-plan extension

Adds a Claude-style `/start-design-plan` workflow to pi without relying on a separate skill.

This extension is a pi port of concepts/workflows from Ed Ropple's `ed3d-plan-and-execute` plugin set:
https://github.com/ed3dai/ed3d-plugins

## Features

- `/start-design-plan` command
- `ask_user_question` tool for structured choices
- `design_plan_tracker` tool for five-phase status tracking
- Progress widget + status line
- Workflow contract in `assets/workflow.md`

## Tools

### `ask_user_question`

Structured decision tool for discrete options.

Parameters:
- `question`: string
- `options`: array of `{ label, description? }`
- `allowOther?`: boolean (defaults to `true`)
- `otherLabel?`: string

### `design_plan_tracker`

State tracker for workflow phases.

Actions:
- `create`
- `get`
- `set_status`
- `append_note`
- `set_design_path`
- `reset`

## Commands

### `/start-design-plan [topic]`

Starts the five-phase design process and injects the workflow instructions into the conversation.

If no topic is supplied, the command prompts for one.

### `/resume-design-plan [optional guidance]`

Resumes an in-progress design workflow from the stored tracker state.

Optional guidance is passed through as additional instruction for the resumed run.
