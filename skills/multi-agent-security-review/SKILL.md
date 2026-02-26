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
### Orchestrator (Primary Session)
Owns scope, tasking, and final report. Aggregates findings, resolves contradictions, and decides what is “real.”

### Tracer
Enumerates sources and dangerous sinks, builds candidate chains, and stops at gates it cannot confirm.

### Resolver
Evaluates gate logic and control flow. Determines whether input can cross a boundary in practice.

### Bypass
Turns a confirmed chain into a reproducible PoC (safe, minimal, and verifiable).

## Coordination Model
Use independent Pi runs for isolation of analysis paths. The orchestrator owns the sequence and spawns each role as a separate `pi` process (via `pi_run` or an SDK session) so each role has a clean context.

**Recommended approach (programmatic spawning):**
1. Orchestrator defines scope, targets, and expected sinks.
2. Orchestrator spawns Tracer via `pi_run` (or SDK `createAgentSession`).
3. Tracer enumerates sinks and builds source→sink chains, then produces a **Resolver task list** for gate verification.
4. Orchestrator spawns a **Resolver per task**, writing to `resolver-<task-id>.md`.
5. Resolver analyzes gates and control-flow completeness, then produces a **Bypass task list** for exploitability validation.
6. Orchestrator spawns a **Bypass per task**, writing to `bypass-<resolver-id>--<bypass-id>.md`.
7. Orchestrator curates all outputs and emits the final report (validated findings only). Outputs are written to the same `security-review/<run-id>/` folder to avoid race conditions.

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
- Decide whether to run **multiple Tracers** (one per macro component or microservice). If so, run separate tracer passes and merge their task lists before spawning Resolvers.
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

### 4) Orchestrator Triage & Report
- Merge only validated chains into final findings.
- Keep a separate “parking lot” list for plausible but unverified issues.
- Correlate findings across components to identify cross-service or cross-module exploit chains.
- Document each issue with a chain-of-exploitation log.

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
