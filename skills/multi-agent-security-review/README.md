# Multi-Agent Security Review — Operational Notes

This file documents implementation details and gotchas for running the multi-agent security review workflow. It is intentionally **not** loaded as a skill so that operational notes do not leak into prompts.

## Persona + Topic Injection
If you are **not** using the stateful-memory extension, you can ignore this section.

Pi loads the **stateful-memory** extension globally (if installed at `~/.pi/agent/extensions/stateful-memory`). When active:
- `SOUL.md`, `STYLE.md`, and `REGISTER.md` are injected into the system prompt on every turn.
- Topic addenda (e.g., `ethical_hacking.md`) are injected dynamically based on the prompt triggers.

**Implication:**
- Do **not** pass persona or topic files manually (`@ethical_hacking.md`) when running tracer/resolver/bypass via `pi`. That would double-load the content.

If you need only the ethical hacking topic and no others, pass a minimal `PI_STATEFUL_MEMORY_TOPICS_FILE` (environment variable) for the subprocesses that contains only that topic.

## Runner Expectations
The repo-local runner `security-review/run-multi-agent-review.sh` spawns separate `pi` processes for each role:
- `tracer.md` is generated first.
- A **resolver per task** is spawned based on the tracer task list.
- A **bypass per task** is spawned based on each resolver task list.
- The orchestrator merges all outputs and emits a final report.

Outputs are written to `security-review/<run-id>/`:
- `tracer.md`
- `resolver-<task-id>.md`
- `bypass-<resolver-id>--<task-id>.md`
- `orchestrator.md`

This avoids collisions when multiple resolvers or bypasses run in parallel.

## Task List Format
Tracer must emit:
- `Resolver Task List`
  - `<task-id>: <gate to verify> (files: path:line-range)`

Resolver must emit:
- `Bypass Task List`
  - `<task-id>: <confirmed chain to exploit> (files: path:line-range)`

The runner sanitizes task IDs for filenames and prefixes bypass output with the resolver task id.

## Optional Isolation
If you need strict isolation (e.g., no global extensions), add `--no-extensions` to the runner’s `pi` invocations and pass explicit context files. This will disable stateful-memory injection.
