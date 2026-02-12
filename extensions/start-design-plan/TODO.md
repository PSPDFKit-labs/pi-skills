# start-design-plan TODO

## Parity / Workflow

- [ ] Add optional subagent orchestration mode (investigator/clarifier/brainstorm roles)
- [ ] Add a setting to choose `single-agent` vs `subagent-assisted` workflow
- [ ] Add strict guardrail mode so discrete decisions always go through `ask_user_question`
- [ ] Add richer completion guardrails (force "done + design path only" response shape)

## UX / Commands

- [ ] Add `/design-plan-status` command (quick tracker summary)
- [ ] Add `/design-plan-reset` command with confirmation prompt
- [ ] Add `/start-design-plan` Resume/Replace/Cancel selector when tracker already exists
- [ ] Add a compact tracker snapshot command for copy/paste into issues/PRs

## Persistence / Recovery

- [ ] Optional file mirror of tracker state in `.pi/design-plan-state.json`
- [ ] Add migration handling for tracker schema/version upgrades
- [ ] Add explicit import/export of tracker state for cross-session handoff

## Quality / Validation

- [ ] Add TypeScript compile/check CI for extension files
- [ ] Add unit tests for tracker transitions and normalization
- [ ] Add integration tests for command flows (`start`, `resume`, completion)
- [ ] Add tests for `ask_user_question` default "Other" behavior

## Documentation

- [ ] Add architecture notes for extension internals (`core`, `tools`, `ui`)
- [ ] Add examples of good prompts for `/resume-design-plan`
- [ ] Document known differences from upstream ed3d plugin behavior
- [ ] Add release/changelog entry conventions for this extension
