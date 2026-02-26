---
name: multi-agent-security-review
description: Multi-agent workflow (tracer/resolver/bypass) for secure code review, exploitability triage, and PoC validation in codebases. Use when conducting structured security research or penetration test analysis.
---

# Multi-Agent Security Review

## Purpose
This skill defines a coordinated, role-based workflow for finding and validating security issues in codebases. It emphasizes source-to-sink reasoning, explicit gate verification, and only reporting exploitability chains that are demonstrably reachable.

The workflow mirrors a research team:
- **Tracer** maps sources → transformations → sinks, and flags gates.
- **Resolver** evaluates gates and control flow completeness.
- **Bypass** proves exploitability with safe PoCs.

## Guardrails
- Operate **only within explicit scope** and permissions.
- Prefer **non-destructive PoCs** and safe payloads.
- If a link is hypothetical, label it and keep it out of final findings.
- Maintain a chain-of-exploitation log for every candidate issue.

## Roles
### Primary Agent (You, the human‑facing session)
Owns scope, tasking, and the final report. Aggregates findings, resolves contradictions, and decides what is “real.” This is the agent the user is talking to.

### Tracer
Enumerates sources and dangerous sinks, builds candidate chains, and stops at gates it cannot confirm.

### Resolver
Evaluates gate logic and control flow. Determines whether input can cross a boundary in practice.

### Bypass
Turns a confirmed chain into a reproducible PoC (safe, minimal, and verifiable).

### Script Orchestrator (runner output)
The `run-multi-agent-review.sh` script produces an **orchestrator.md** file at the end. That file is an automated merge of tracer/resolver/bypass outputs and is **not** the same as the Primary Agent. The Primary Agent should still read and curate that output before final reporting.

## Coordination Model
Use independent Pi runs for isolation of analysis paths. The **Primary Agent** owns the sequence and spawns each role as a separate `pi` process (via `pi_run` or an SDK session) so each role has a clean context.

**Recommended approach (programmatic spawning):**
1. Primary Agent defines scope, targets, and expected sinks.
2. Primary Agent spawns Tracer via `pi_run` (or SDK `createAgentSession`).
3. Tracer enumerates sinks and builds source→sink chains, then produces a **Resolver task list** for gate verification.
4. Primary Agent spawns a **Resolver per task**, writing to `resolver-<task-id>.md`.
5. Resolver analyzes gates and control-flow completeness, then produces a **Bypass task list** for exploitability validation.
6. Primary Agent spawns a **Bypass per task**, writing to `bypass-<resolver-id>--<bypass-id>.md`.
7. The **script orchestrator** (runner) can merge outputs into `orchestrator.md`, but the Primary Agent still curates and emits the final report.

**Handoff format (required):**
```
Role: <Tracer|Resolver|Bypass>
Target: <file/module/subsystem>
Summary: <1–3 sentences>
Evidence: <file paths, line ranges, or code references>
Open Questions: <what you could not verify>
Next Actions: <what you recommend>
```

## Workflow (End-to-End)

### Automation Hook (Runner from cold)
This skill ships with a runner script at:
`~/.pi/agent/skills/multi-agent-security-review/run-multi-agent-review.sh`

It supports `--parallel <n>` to run resolver and bypass tasks concurrently.
Guidance: start with `--parallel 2` or `--parallel 4` on laptops, and use `min(available CPU cores, number of tasks)` on larger machines. Avoid setting it so high that it starves your main session or hits provider rate limits.

From a cold session, run it from the repo root (or copy it into the repo as `security-review/run-multi-agent-review.sh` and `chmod +x` it). It will spawn tracer → resolver → bypass → orchestrator as independent `pi` runs and write outputs to `security-review/<run-id>/`.

Example:
```
/home/parallels/.pi/agent/skills/multi-agent-security-review/run-multi-agent-review.sh \
  --focus "Provisioning SSH host key handling" \
  --target "nixos/templates/nixos-anywhere-eyd.sh" \
  --context nixos/templates/nixos-anywhere-eyd.sh \
  --context nixos/templates/README.md \
  --parallel 2
```

### 0) Scope & Inventory (Orchestrator)
- Confirm threat model, constraints, and test boundaries.
- Identify high-value subsystems (parsers, upload pipelines, rendering, network calls, auth boundaries).
- **Decide batch size before you run anything.** If the scope spans multiple major components or languages, split into separate runs. Indicators that you should split:
  - Multiple top-level products/services (e.g., web UI, native core, backend service).
  - Distinct trust models (client UI vs server processing vs local SDKs).
  - Mixed languages/toolchains or very large directories.
  - The tracer would need to read unrelated contexts to build chains.
  - You can’t clearly describe a single threat model that covers everything.
- **Default rule:** if you think “this is a lot of context,” it is. Run separate tracers per logical component and only merge at the correlation step.
- If splitting, run one tracer per component and keep outputs in separate `security-review/<run-id>/` folders; merge findings during correlation.
- Establish a shared notes location (repo-local `security-review/<run-id>/` folder).
- Use independent `pi` runs for each role and persist outputs as:
  - `security-review/<run-id>/tracer.md`
  - `security-review/<run-id>/resolver-<task-id>.md`
  - `security-review/<run-id>/bypass-<resolver-id>--<bypass-id>.md`
  - `security-review/<run-id>/orchestrator.md`

### 1) Tracer Pass (Source-to-Sink Mapping)
Tracer focuses on reachability and flow, not exploitability.

**Tasks:**
- Enumerate **sources**: file inputs, HTTP params, IPC, environment, plugin APIs, webviews.
- Enumerate **sinks**: eval-like calls, deserialization, filesystem, network, template renderers, DOM insertion, command execution.
- Build chains: `source → transforms → sink`.
- Mark each chain with **gate points** (validation, sanitization, authorization, type coercion).
- Produce a **Resolver task list**: gates that require verification, with file paths and line ranges.
- Use this task list format:
  - `<task-id>: <gate to verify> (files: path:line-range)`

**Tracer output:**
- Candidate chains with gates and references.
- A prioritized list of sinks with the shortest path from untrusted input.
- Resolver task list (explicit handoff targets).

### 2) Resolver Pass (Gate Verification)
Resolver validates whether each gate is real, complete, and correct.

**Tasks:**
- Inspect validation logic, type checks, and encoding steps.
- Verify control flow: is the check mandatory or optional? Can the chain bypass it?
- Confirm middleware ordering and handler precedence.
- Produce a **Bypass task list** for any chain where gates are bypassable or insufficient.
- Use this task list format:
  - `<task-id>: <confirmed chain to exploit> (files: path:line-range)`
- The orchestrator prefixes bypass file names with the resolver task id to avoid collisions.

**Resolver output:**
- “Gate holds” or “gate bypassable” conclusions with evidence.
- Conditions required to pass the gate if any.
- Bypass task list (explicit handoff targets).

### 3) Bypass Pass (Exploitability)
Bypass proves exploitability with a minimal, safe PoC.

**Tasks:**
- Model runtime context (data format, encoding, parser behavior).
- Choose a safe payload format that matches the data path.
- Construct a PoC showing concrete reachability to the sink.

**Bypass output:**
- PoC description (and payload if safe to share).
- Expected vs observed behavior.
- Impact statement tied to the verified chain.

### 4) Primary Agent Triage & Report
- Merge only validated chains into final findings.
- Keep a separate “parking lot” list for plausible but unverified issues.
- Correlate findings across components to identify cross-service or cross-module exploit chains.
- Document each issue with a chain-of-exploitation log.

### 5) Post-Run Validation & Correlation (Cold-Start Playbook)
Use this after the multi-agent runs complete to promote parking-lot items and produce a final report. This is the exact workflow used in practice and is designed for a cold Primary Agent with no project context.

### 6) Sink Report (Final Step — Post-Final-Report)
Create a **sink report** after the final report is drafted. The sink report is a focused, high‑level guide for developers and security engineers that highlights the **top sinks of concern** per component. It is not a vulnerability list; it is a **maintenance map** that shows where future changes are most likely to introduce security risk.

**Purpose**
- Provide a concise list of the most sensitive sinks (DOM insertion, network fetch, filesystem, command exec).
- Show how data reaches each sink with a simple architecture view.
- Equip developers to recognize “gotcha” areas during refactors or feature additions.

**Required inputs**
- Tracer outputs for each component (`security-review/<run-id>/tracer.md`).
- Any final report notes to confirm confirmed vs parking‑lot status.

**Method (Cold‑Start Playbook)**
1. **Read each tracer report** and extract the sinks called out in the Summary/Evidence sections.
2. **Group sinks by component** (e.g., web UI, core rendering, server backend).
3. For each component, **build a high‑level data‑flow diagram** in Mermaid:
   - Show primary ingress points (e.g., annotations/Instant JSON, URL params, HTML generation payloads).
   - Show transformation chokepoints (deserialization, parsing, policy checks).
   - End the diagram at the sink (DOM insertion, network fetch, filesystem write, command execution).
4. **Write the “Top Sinks of Concern” list** for each component:
   - Keep it concise (3–6 items per component).
   - For each sink, explain why it’s sensitive, and what change patterns are risky.
   - Call out any important guardrails (sanitizers, allowlists, permissions, or default settings) that make the sink safer or more dangerous.
5. **Add evidence references** (file paths and line ranges) for each top sink so engineers can jump to code quickly.

**Output**
- Write to `security-review/sink-report.md`.
- Include Mermaid diagrams and a short summary section per component.
- Close with a compact evidence list per component.

**Quality bar**
- The sink report should be **actionable for developers** even without reading the full security review.
- It should be clear where untrusted data enters, where it is transformed, and where it finally lands.
- It should emphasize *maintenance risk*: “if you change this area, you can accidentally re‑introduce X.”

**A. Gather outputs**
1. Identify the run folders under `security-review/<run-id>/` for each component (web/core/docengine). If the scope is broad, run **separate tracers per component** and keep outputs separate.
2. Read the `orchestrator.md` for each run to collect:
   - Validated findings
   - Parking‑lot candidates
   - Evidence paths/line ranges
3. Create a working summary (notes or a new report file) that lists each parking‑lot item with its suspected source and sink.

**B. Validate parking‑lot items**
4. For each parking‑lot item, trace **source → sink** manually using `grep` and `read`:
   - Identify **untrusted input sources** (network payloads, document metadata, config injection, postMessage, URL params, remote JSON).
   - Identify **serialization/deserialization boundaries** (e.g., JSON → model objects).
   - Identify **DOM or backend sinks** (innerHTML, dangerouslySetInnerHTML, URL fetch, filesystem, command exec).
5. Confirm **trust boundary crossing**:
   - If the source is user‑controlled and the sink is sensitive with no sanitizer/allow‑list gate, promote the finding.
   - If the source is only internal/trusted and there is no evidence of untrusted input, keep it in the parking lot.
6. Record **preconditions** explicitly (e.g., specific endpoints exposed, JWT claims default to permissive values, remote assets enabled).

**C. Correlation pass**
7. Cross‑map findings between components to identify compounded chains:
   - Example: **Core annotation JSON → Web UI DOM sink**.
   - Example: **Server‑side URL ingestion → SSRF across services**.
8. Note any “shared choke points” (e.g., URIAction scheme handling, config ingestion paths, HTML generation settings) that affect multiple components.

**D. Final report assembly**
9. Write a `security-review/final-report.md` with:
   - Executive summary
   - Correlated threads (cross‑component risks)
   - Validated findings with preconditions
   - Parking‑lot findings with next validation steps
10. Append a **findings appendix** listing each item with evidence: file paths, functions, and line ranges.

**E. Practical tips**
- Prefer `grep` for sources/sinks discovery, then `read` exact files for evidence.
- When correlating, always identify the **hand‑off boundary** (e.g., JSON payloads crossing from backend → frontend).
- Promote only findings that have a concrete chain and a clear trust boundary violation.
- Keep PoCs safe; if you can’t safely validate, state that and keep the item in the parking lot.

## Chain-of-Exploitation Log (Template)
Use this format for every finding. If a link is unverified, do not promote it to a final finding.

```
Title:
Entry Point:
Untrusted Input:
Transformations:
Gate(s) + Status:
Sink:
Exploitability Proof:
Impact:
Mitigation Notes:
Evidence (files/lines):
```

## Document-Heavy System Focus
Pay special attention to:
- Parser boundaries: tokenization, AST building, type coercion.
- DOM insertion, template rendering, and iframe embedding.
- URL fetching, embedded resources, and SSRF/CSRF pathways.
- Mixed trust sources (client-provided metadata + server side enrichment).

## Success Criteria
A finding is “real” only if:
- The chain is **reachable**.
- The **gate behavior** is verified.
- The **sink** is reached with a safe PoC.
- The **impact** is concrete and reproducible.

## When to Use This Skill
- Deep codebase review for AppSec or pentest preparation.
- Reviewing document parsing/processing systems.
- Coordinating multi-role exploration without losing traceability.
