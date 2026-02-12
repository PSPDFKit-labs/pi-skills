# /start-design-plan Workflow

You are running an orchestrated design workflow. Follow this five-phase sequence exactly:

1. Context Gathering
2. Clarification
3. Definition of Done
4. Brainstorming
5. Design Documentation

## Global execution rules

- Never skip a phase.
- Use `design_plan_tracker` throughout the workflow:
  - `action=get` at the start (tracker is initialized by `/start-design-plan`)
  - `action=create` only if tracker is missing
  - `action=set_status` as phases move to `in_progress` and `completed`
  - `action=append_note` for important decisions
  - `action=set_design_path` when the design document path is known
- Use `ask_user_question` for discrete option decisions.
- Ask only one meaningful question at a time when gathering open-ended context.
- Research-first requirement (from ed3d flow):
  - Before Phase 2 clarification questions, run `design_research_fanout` with `phase=context`.
  - During Phase 4 brainstorming, run `design_research_fanout` with `phase=brainstorm` before selecting approaches.
  - Use findings to reduce low-value questions and ground trade-off discussion.

## Phase 1: Context Gathering

Collect freeform inputs:

- What is being built?
- Goals / success criteria
- Constraints and requirements
- Relevant file paths and docs
- Existing patterns and architecture constraints
- Scope exclusions (if known)

Mark Phase 1 in progress, gather context, then mark it completed.

## Phase 2: Clarification

Before asking clarification questions:

1. Run `design_research_fanout` with `phase=context` for codebase-first investigation.
2. Review findings and resolve obvious ambiguities without asking the user yet.

Then disambiguate:

- contradictions (resolve trade-offs first)
- technical terms
- scope boundaries
- assumptions behind constraints

Use `ask_user_question` for explicit choices.

Mark Phase 2 in progress, then completed once requirements are clear.

## Phase 3: Definition of Done

Before brainstorming implementation approaches, confirm success criteria.

- Summarize primary deliverables, success criteria, and exclusions.
- Ask for confirmation.
- If unclear, ask targeted follow-ups.

After confirmation:

1. Ask for a plan slug (present 2-3 suggestions)
2. Create the design file immediately:
   `docs/design-plans/YYYY-MM-DD-<slug>.md`
3. Initialize content with:

```markdown
# <Feature> Design

## Summary
<!-- TO BE GENERATED after body is written -->

## Definition of Done
<confirmed DoD>

## Acceptance Criteria
<!-- TO BE GENERATED and validated before glossary -->

## Glossary
<!-- TO BE GENERATED after body is written -->
```

Then set Phase 3 complete and call `design_plan_tracker action=set_design_path`.

## Phase 4: Brainstorming

Research-gated brainstorming:

1. Understanding checkpoint:
   - Run `design_research_fanout` with `phase=brainstorm` (or custom goals) to investigate current state and constraints.
2. Exploration checkpoint:
   - If needed, run a second `design_research_fanout` call with custom goals focused on alternatives and trade-offs.

Then:

- Propose 2-3 architectural approaches grounded in findings
- Compare trade-offs
- Prefer existing codebase patterns when sensible
- Have the user choose
- Validate in small sections

No implementation code. Contracts/interfaces are fine.

Mark Phase 4 completed once approach is validated.

## Phase 5: Design Documentation

Append validated design to the existing design file:

- Architecture
- Existing Patterns
- Implementation Phases (3-8 phases, max 8)
- Additional Considerations (if needed)

Use phase markers:

```markdown
<!-- START_PHASE_1 -->
### Phase 1: <name>
**Goal:** ...
**Components:** ...
**Dependencies:** ...
**Done when:** ...
<!-- END_PHASE_1 -->
```

Then generate:

- Acceptance Criteria (specific, observable, testable)
- Summary (1-2 paragraphs)
- Glossary (terms worth defining)

Mark Phase 5 complete when the design document is done.

## Completion

When Phase 5 is completed:

- Announce that design planning is complete.
- Report the final design path (`docs/design-plans/YYYY-MM-DD-<slug>.md`).
- Stop.
- Do not hand off into implementation planning.
- Do not suggest `/clear`, copy commands, or implementation-plan commands.

## Quality bar

- Be direct and explicit.
- Avoid generic filler.
- Keep artifacts durable and implementation-ready.
- Preserve exact file paths and concrete boundaries.
