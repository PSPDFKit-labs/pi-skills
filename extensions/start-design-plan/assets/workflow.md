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
  - `action=add_task` to register research/exploration tasks per phase
  - `action=set_task_status` to mark task progression (`pending`/`in_progress`/`completed`/`blocked`/`failed`)
  - `action=append_task_note` to preserve findings and rationale
  - `action=list_tasks` when deciding what remains blocked
- Use `ask_user_question` for every discrete option decision with 2+ choices.
- Do not present numbered/bulleted option menus directly in assistant text when `ask_user_question` should be used.
- Ask only one meaningful question at a time when gathering open-ended context.
- Research-first requirement (from ed3d flow):
  - Before Phase 2 clarification questions, run `design_research_fanout` with `phase=context`.
  - During Phase 4 brainstorming, run `design_research_fanout` with `phase=brainstorm` before selecting approaches.
  - Respect `/design-plan-config` defaults for research fanout (`model`, `max-agents`, `include-internet`) unless this run needs explicit overrides.
  - Read outputs by role label (`*-investigator`, `*-analyst`, `*-researcher`) and preserve important findings in tracker notes.
  - Use findings to reduce low-value questions and ground trade-off discussion.
- Research goal composition — goals MUST cover three perspectives:
  1. **Internal (codebase):** Map current implementation, identify code paths, find existing patterns.
     - Example: "Map the current PDF loading path and identify where range requests are made"
     - Example: "Find existing error handling patterns in the auth module"
  2. **Domain (specification/theory):** Research the underlying spec, protocol, or standard that governs the problem. Ask "how does X work at the spec level?" and "what data structures / fields / mechanisms does the spec provide that we might not be using?"
     - Example: "Research the PDF linearization specification — what data is in the linearization dictionary? What fields indicate where first-page data ends?"
     - Example: "Research the OAuth 2.0 PKCE spec — what's the exact flow and what security properties does it provide?"
  3. **External (competitors/best practices):** Research how other implementations solve the same problem. Ask "what do competitors do?", "what are known best practices?", "what are common pitfalls?"
     - Example: "How do PDF.js, PDFium, and other viewers optimize linearized PDF loading for fast first-page render?"
     - Example: "What are known best practices for implementing progressive image loading in web apps?"
  - If you write only internal goals, you will miss optimizations visible only through spec knowledge or competitor analysis.
  - The internet-researcher role exists specifically for goals 2 and 3 — give it domain-level and external research work, not instrumentation tasks.
  - **Goal delegation by role type:**
    - codebase-investigator: "How is X currently implemented?", "Where does Y live?", "What patterns exist for Z?"
    - internet-researcher: "What does the spec say about X?", "How do competitors solve Y?", "What's the current best practice for Z?", "What are known pitfalls of approach W?"
    - analyst: "Given codebase state X and spec capability Y, what are the viable approaches and trade-offs?"
- Task graph requirement:
  - Represent research/exploration work as explicit tasks with dependencies.
  - Use `blockedBy` when a task cannot start until another task completes.
  - Do not advance a phase while required tasks remain `blocked`, `pending`, or `in_progress`.

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

1. Create research tasks for Phase 2 using `design_plan_tracker action=add_task`.
   - Example tasks: `context-codebase`, `context-constraints`, `context-internet`.
2. Set the first research task to `in_progress`.
3. Write research goals covering all three perspectives (internal, domain, external):
   - Internal: Map the current implementation and identify bottlenecks.
   - Domain: Research the relevant spec/protocol/standard — what mechanisms or data exist that could be exploited?
   - External: Research how competitors or other implementations solve the same problem. What best practices exist? What are known pitfalls?
4. Run `design_research_fanout` with `phase=context` and these goals.
5. Mark completed tasks with `action=set_task_status` and append notable findings with `action=append_task_note`.
6. If one task depends on another, keep it `blocked` until dependencies complete.
7. Review findings and resolve obvious ambiguities without asking the user yet.

Then disambiguate — in this order:

1. **Contradictions first.** Scan for mutually exclusive goals or unacknowledged trade-offs. If the user stated conflicting requirements, resolve those before anything else — technical clarification is wasted effort if the foundation shifts.
   - Don't accuse — illuminate: "I notice X and Y can pull in different directions. Which takes priority?"
2. **Technical terms.** Disambiguate anything that could mean multiple things (e.g., "caching" → application-level? HTTP? DB query?).
3. **Scope boundaries.** Identify what's included and excluded.
4. **Assumptions behind constraints.** When user says "must use X", understand why — is it regulatory, team preference, or misconception?

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

Research-gated brainstorming with iterative refinement:

1. Create brainstorming tasks with dependencies (`action=add_task`, `blockedBy`).
   - Example: `brainstorm-round1` -> `brainstorm-round2` -> `brainstorm-selection`.

2. **Round 1 — Understanding checkpoint:**
   - Set `brainstorm-round1` to `in_progress`.
   - Write brainstorm goals that go deeper than context phase — ask targeted questions informed by what context research found. Include:
     - Deep-dive codebase investigation of specific bottlenecks identified in context phase
     - Domain/spec research on mechanisms that could address identified bottlenecks
     - External research on how others solved the specific problem pattern
   - Run `design_research_fanout` with `phase=brainstorm` and these goals.
   - Mark task complete and append notes.

3. **Round 2 — Targeted follow-up (required when round 1 has gaps):**
   - Review round 1 results. Identify:
     - Unanswered questions or "not found" results from round 1
     - New questions raised by round 1 findings (e.g., round 1 found a spec mechanism — now investigate how the codebase could use it)
     - Specific claims that need verification from a different perspective (e.g., codebase investigator found a pattern — does it match spec best practice?)
   - If any of these exist, set `brainstorm-round2` to `in_progress` and run a second `design_research_fanout` with targeted goals addressing the gaps.
   - If round 1 fully answered all three perspectives with no gaps, skip round 2. But be honest — single-round research rarely covers everything.
   - Mark task complete and append notes.

4. Before approach selection, call `design_plan_tracker action=list_tasks` and ensure no required brainstorming task is blocked/pending.

Then:

- Present a **Research Digest** before asking for a decision:
  - 3-6 bullets combining findings across both rounds
  - Include concrete file paths/symbols/URLs when available
  - Note what was searched but not found
- Propose 2-3 architectural approaches grounded in that digest
- Compare trade-offs
- Prefer existing codebase patterns when sensible
- Have the user choose (use `ask_user_question`)
- Validate the selected approach in small sections (200-300 words each), asking for feedback after each

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

- Respond with exactly two lines and no extra text:
  - `Design planning is complete.`
  - `Design path: docs/design-plans/YYYY-MM-DD-<slug>.md`
- Stop.
- Do not hand off into implementation planning.
- Do not suggest `/clear`, copy commands, or implementation-plan commands.

## Question quality

When asking questions with `ask_user_question`:

- **Do not present trap options.** If only one answer is useful, coherent, and effective, state your assumption and move on. Do not manufacture fake alternatives to create the appearance of a choice.
- **Every option must be genuinely viable.** If you can't explain why someone would reasonably pick an option, remove it.
- **Use open-ended questions for validation** ("Does this look right?"), structured questions for decisions ("Which approach?").
- **Do not ask questions just to ask them.** If you have no useful questions, stop asking and proceed.
- **One question at a time** when gathering open-ended context.

## When to revisit earlier phases

You can and should go backward when:
- Phase 2 reveals fundamental gaps → return to Phase 1
- Phase 3 reveals unclear deliverables → return to Phase 2
- Phase 4 uncovers new constraints → return to Phase 1, 2, or 3
- User questions the selected approach → return to Phase 4
- Research reveals a constraint you didn't know about → reassess the affected phase

Don't force forward linearly when going backward would give better results.

## Common rationalizations — STOP

These are violations of the workflow requirements:

| Excuse | Reality |
|--------|---------|
| "Requirements are clear, skip research" | Research reveals what you don't know you don't know. Always run fanout. |
| "I can research this quickly myself" | You'll consume context and may hallucinate. Delegate to research agents. |
| "Only need codebase goals, no domain/external" | You'll miss optimizations visible only through spec knowledge or competitor analysis. |
| "One research round is enough" | Review round 1 for gaps. If questions remain, run round 2. |
| "Obvious solution, skip brainstorming" | Codebase may have an established pattern. Spec may have a mechanism you're unaware of. Check first. |
| "Idea is simple, skip exploring alternatives" | Always propose 2-3 approaches. Comparison reveals issues. |
| "I'll present the whole design at once" | Validate in small sections. Incremental validation catches problems early. |
| "I know this codebase, don't need investigator" | You don't know the current state. Always verify. |
| "Don't need internet research for this" | External knowledge and current docs matter. Research when relevant. |
| "I'll show implementation code so the user understands" | Show contracts/interfaces, not implementation. |
| "Only one answer makes sense but I'll present options anyway" | State your assumption and move on. Don't present trap options. |

**All of these mean: STOP. Follow the requirements exactly.**

## Quality bar

- Be direct and explicit.
- Avoid generic filler.
- Keep artifacts durable and implementation-ready.
- Preserve exact file paths and concrete boundaries.
