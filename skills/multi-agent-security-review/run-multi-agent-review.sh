#!/usr/bin/env bash
set -euo pipefail

log() {
  printf '[multi-agent-review] %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
Usage: run-multi-agent-review.sh [options]

Options:
  --run-id <id>           Run identifier (default: timestamp)
  --focus <text>          Focus area / threat model note for the review
  --target <text>         Target subsystem (repeatable)
  --context <path>        Context file to include via @file (repeatable)
  --pi-cmd <path>         Pi executable (default: pi)
  --parallel <n>          Max parallel resolver/bypass workers (default: 1)
  -h, --help              Show help

Examples:
  /home/parallels/.pi/agent/skills/multi-agent-security-review/run-multi-agent-review.sh \
    --focus "Provisioning SSH host key handling" \
    --target "nixos/templates/nixos-anywhere-eyd.sh" \
    --context nixos/templates/nixos-anywhere-eyd.sh \
    --context nixos/templates/README.md
EOF
}

RUN_ID="$(date +%Y%m%d-%H%M%S)"
FOCUS=""
PI_CMD="pi"
PARALLEL=1
TARGETS=()
CONTEXT_FILES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="$2"
      shift 2
      ;;
    --focus)
      FOCUS="$2"
      shift 2
      ;;
    --target)
      TARGETS+=("$2")
      shift 2
      ;;
    --context)
      CONTEXT_FILES+=("$2")
      shift 2
      ;;
    --pi-cmd)
      PI_CMD="$2"
      shift 2
      ;;
    --parallel)
      PARALLEL="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

RUN_DIR="security-review/${RUN_ID}"
mkdir -p "${RUN_DIR}"
log "Run directory: ${RUN_DIR}"
log "PI command: ${PI_CMD}"
log "Parallel workers: ${PARALLEL}"

TARGET_SUMMARY="(not specified)"
if [[ ${#TARGETS[@]} -gt 0 ]]; then
  TARGET_SUMMARY=$(IFS=", "; echo "${TARGETS[*]}")
fi

FOCUS_LINE=""
if [[ -n "${FOCUS}" ]]; then
  FOCUS_LINE="Focus: ${FOCUS}"
fi

CONTEXT_ARGS=()
for file in "${CONTEXT_FILES[@]}"; do
  CONTEXT_ARGS+=("@${file}")
done

COMMON_ARGS=("--no-session" "--tools" "read,grep,find,ls" "-p")

job_count() {
  jobs -pr | wc -l | tr -d ' '
}

wait_for_slot() {
  while (( $(job_count) >= PARALLEL )); do
    sleep 0.2
  done
}

wait_for_pids() {
  local fail=0
  for pid in "$@"; do
    if ! wait "$pid"; then
      fail=1
    fi
  done
  return $fail
}

sanitize_id() {
  local raw="$1"
  local cleaned
  cleaned=$(printf '%s' "${raw}" | sed 's/[^A-Za-z0-9_.-]/-/g')
  cleaned=${cleaned##-}
  cleaned=${cleaned%%-}
  if [[ -z "${cleaned}" ]]; then
    cleaned="task"
  fi
  printf '%s' "${cleaned}"
}

task_files_to_context() {
  local files="$1"
  local -a contexts=()
  local IFS=';,'
  for entry in $files; do
    entry=$(printf '%s' "$entry" | sed 's/^ *//; s/ *$//')
    [[ -z "$entry" ]] && continue
    entry=$(printf '%s' "$entry" | sed 's/:[0-9][0-9]*\(-[0-9][0-9]*\)\?$//')
    if [[ -f "$entry" ]]; then
      contexts+=("@$entry")
    fi
  done
  printf '%s\n' "${contexts[@]}"
}

extract_tasks() {
  local section="$1"
  local input_file="$2"
  awk -v section="$section" '
    BEGIN { in_section = 0; count = 0 }
    $0 ~ "^" section "" { in_section = 1; next }
    in_section {
      if ($0 ~ /^[A-Za-z].*:\s*$/ && $0 !~ /^- /) { exit }
      if ($0 ~ /^- /) {
        count++
        line = $0
        sub(/^- /, "", line)
        id = ""
        desc = line
        files = ""
        if (match(line, /^[A-Za-z0-9_-]+:/)) {
          id = substr(line, 1, RLENGTH - 1)
          desc = substr(line, RLENGTH + 1)
          sub(/^\s+/, "", desc)
        } else {
          id = sprintf("task-%02d", count)
        }
        if (match(desc, /\(files:[^)]+\)/)) {
          files = substr(desc, RSTART, RLENGTH)
          sub(/^\(files:[[:space:]]*/, "", files)
          sub(/\)$/, "", files)
          gsub(/[[:space:]]+/, " ", files)
          sub(/[[:space:]]*\(files:[^)]+\)/, "", desc)
          sub(/[[:space:]]+$/, "", desc)
        }
        trimmed = desc
        gsub(/^[[:space:]]+/, "", trimmed)
        gsub(/[[:space:]]+$/, "", trimmed)
        if (tolower(id) == "none") { next }
        if (tolower(trimmed) ~ /^none\b/ || tolower(trimmed) ~ /^none\.?$/) { next }
        print id "\t" desc "\t" files
      }
    }
  ' "${input_file}"
}

TRACER_PROMPT=$(cat <<EOF
You are the Tracer. Enumerate dangerous sinks, then build source→sink chains and list gates. When you hit a gate that requires verification, add it to a Resolver task list.

${FOCUS_LINE}
Targets: ${TARGET_SUMMARY}

Produce the required handoff format:
Role: Tracer
Target: <file/module/subsystem>
Summary: <1–3 sentences>
Evidence: <file paths, line ranges, or code references>
Open Questions: <what you could not verify>
Next Actions: <what you recommend>

Append a "Resolver Task List" section with bullet points in this format:
- <task-id>: <gate to verify> (files: path:line-range)

Only include validated observations from the provided files or tool output.
EOF
)

log "Starting tracer..."
"${PI_CMD}" "${COMMON_ARGS[@]}" "${CONTEXT_ARGS[@]}" "${TRACER_PROMPT}" > "${RUN_DIR}/tracer.md" </dev/null
log "Tracer done: ${RUN_DIR}/tracer.md"

RESOLVER_TASKS=()
while IFS=$'\t' read -r task_id task_desc task_files; do
  [[ -z "${task_id}" ]] && continue
  task_id="$(sanitize_id "${task_id}")"
  RESOLVER_TASKS+=("${task_id}::${task_desc}")
done < <(extract_tasks "Resolver Task List" "${RUN_DIR}/tracer.md")

if [[ ${#RESOLVER_TASKS[@]} -eq 0 ]]; then
  log "No resolver tasks found. Skipping resolver/bypass and producing orchestrator report."
else
  RESOLVER_PIDS=()
  for task in "${RESOLVER_TASKS[@]}"; do
    task_id="${task%%::*}"
    task_desc="${task#*::}"

    log "Starting resolver ${task_id}..."
    RESOLVER_PROMPT=$(cat <<EOF
You are the Resolver. Use the Tracer handoff to verify gates and control-flow completeness for the task below. Determine whether the gate blocks the chain. If a chain is bypassable or insufficiently gated, add it to a Bypass task list.

Task: ${task_id}: ${task_desc}
${FOCUS_LINE}
Targets: ${TARGET_SUMMARY}

Produce the required handoff format:
Role: Resolver
Target: <file/module/subsystem>
Summary: <1–3 sentences>
Evidence: <file paths, line ranges, or code references>
Open Questions: <what you could not verify>
Next Actions: <what you recommend>

Append a "Bypass Task List" section with bullet points in this format:
- <task-id>: <confirmed chain to exploit> (files: path:line-range)

Only include validated observations from the provided files or tool output.
EOF
)

    resolver_output="${RUN_DIR}/resolver-${task_id}.md"
    if (( PARALLEL > 1 )); then
      wait_for_slot
      (
        "${PI_CMD}" "${COMMON_ARGS[@]}" "@${RUN_DIR}/tracer.md" "${CONTEXT_ARGS[@]}" "${RESOLVER_PROMPT}" > "${resolver_output}" </dev/null
        log "Resolver done: ${resolver_output}"
      ) &
      RESOLVER_PIDS+=("$!")
    else
      "${PI_CMD}" "${COMMON_ARGS[@]}" "@${RUN_DIR}/tracer.md" "${CONTEXT_ARGS[@]}" "${RESOLVER_PROMPT}" > "${resolver_output}" </dev/null
      log "Resolver done: ${resolver_output}"
    fi
  done
  if (( PARALLEL > 1 )) && [[ ${#RESOLVER_PIDS[@]} -gt 0 ]]; then
    if ! wait_for_pids "${RESOLVER_PIDS[@]}"; then
      log "Resolver phase failed."
      exit 1
    fi
  fi
fi

BYPASS_TASK_IDS=()
BYPASS_TASK_DESCS=()
BYPASS_TASK_FILES=()
BYPASS_TASK_RESOLVERS=()
for resolver_file in "${RUN_DIR}"/resolver-*.md; do
  [[ ! -f "${resolver_file}" ]] && continue
  while IFS=$'\t' read -r task_id task_desc task_files; do
    [[ -z "${task_id}" ]] && continue
    task_id="$(sanitize_id "${task_id}")"
    BYPASS_TASK_IDS+=("${task_id}")
    BYPASS_TASK_DESCS+=("${task_desc}")
    BYPASS_TASK_FILES+=("${task_files}")
    BYPASS_TASK_RESOLVERS+=("${resolver_file}")
  done < <(extract_tasks "Bypass Task List" "${resolver_file}")
done

if [[ ${#BYPASS_TASK_IDS[@]} -eq 0 ]]; then
  log "No bypass tasks found. Skipping bypass step."
else
  BYPASS_PIDS=()
  BYPASS_FAILURES_FILE="${RUN_DIR}/bypass-failures.txt"
  : > "${BYPASS_FAILURES_FILE}"
  for idx in "${!BYPASS_TASK_IDS[@]}"; do
    task_id="${BYPASS_TASK_IDS[$idx]}"
    task_desc="${BYPASS_TASK_DESCS[$idx]}"
    task_files="${BYPASS_TASK_FILES[$idx]}"
    resolver_file="${BYPASS_TASK_RESOLVERS[$idx]}"

    resolver_base=$(basename "${resolver_file}")
    resolver_id=${resolver_base#resolver-}
    resolver_id=${resolver_id%.md}
    resolver_id=$(sanitize_id "${resolver_id}")
    bypass_id="${resolver_id}--${task_id}"

    log "Starting bypass ${bypass_id}..."
    BYPASS_PROMPT=$(cat <<EOF
You are the Bypass. Use the Tracer and Resolver handoffs. Attempt to prove exploitability with a safe PoC if possible; otherwise mark as unverified. Focus on the task below.

Task: ${task_id}: ${task_desc}
${FOCUS_LINE}
Targets: ${TARGET_SUMMARY}

Produce the required handoff format:
Role: Bypass
Target: <file/module/subsystem>
Summary: <1–3 sentences>
Evidence: <file paths, line ranges, or code references>
Open Questions: <what you could not verify>
Next Actions: <what you recommend>

If no PoC is feasible, state that explicitly and keep findings in the parking lot.
Only include validated observations from the provided files or tool output.
EOF
)

    bypass_output="${RUN_DIR}/bypass-${bypass_id}.md"
    task_context_args=("${CONTEXT_ARGS[@]}")
    if [[ -n "${task_files}" ]]; then
      while IFS= read -r entry; do
        [[ -n "${entry}" ]] && task_context_args+=("${entry}")
      done < <(task_files_to_context "${task_files}")
    fi
    if (( PARALLEL > 1 )); then
      wait_for_slot
      (
        if "${PI_CMD}" "${COMMON_ARGS[@]}" "@${RUN_DIR}/tracer.md" "@${resolver_file}" "${task_context_args[@]}" "${BYPASS_PROMPT}" > "${bypass_output}" </dev/null; then
          log "Bypass done: ${bypass_output}"
        else
          log "Bypass failed: ${bypass_output}"
          printf '%s\t%s\t%s\t%s\n' "${bypass_id}" "${task_id}" "${task_desc}" "${resolver_file}" >> "${BYPASS_FAILURES_FILE}"
          exit 1
        fi
      ) &
      BYPASS_PIDS+=("$!")
    else
      if "${PI_CMD}" "${COMMON_ARGS[@]}" "@${RUN_DIR}/tracer.md" "@${resolver_file}" "${task_context_args[@]}" "${BYPASS_PROMPT}" > "${bypass_output}" </dev/null; then
        log "Bypass done: ${bypass_output}"
      else
        log "Bypass failed: ${bypass_output}"
        printf '%s\t%s\t%s\t%s\n' "${bypass_id}" "${task_id}" "${task_desc}" "${resolver_file}" >> "${BYPASS_FAILURES_FILE}"
      fi
    fi
  done
  if (( PARALLEL > 1 )) && [[ ${#BYPASS_PIDS[@]} -gt 0 ]]; then
    wait_for_pids "${BYPASS_PIDS[@]}" || true
  fi

  if [[ -s "${BYPASS_FAILURES_FILE}" ]]; then
    log "Retrying failed bypass tasks using resolver output only..."
    while IFS=$'\t' read -r bypass_id task_id task_desc resolver_file; do
      log "Retrying bypass ${bypass_id}..."
      BYPASS_RETRY_PROMPT=$(cat <<EOF
You are the Bypass. The previous bypass run failed. Use ONLY the Resolver handoff below as context and try to reconstruct exploitability. Figure it out as best you can, and be explicit about any missing information.

Task: ${task_id}: ${task_desc}
${FOCUS_LINE}
Targets: ${TARGET_SUMMARY}

Produce the required handoff format:
Role: Bypass
Target: <file/module/subsystem>
Summary: <1–3 sentences>
Evidence: <file paths, line ranges, or code references>
Open Questions: <what you could not verify>
Next Actions: <what you recommend>

If no PoC is feasible, state that explicitly and keep findings in the parking lot.
Only include validated observations from the provided files or tool output.
EOF
)
      retry_output="${RUN_DIR}/bypass-${bypass_id}-retry.md"
      if "${PI_CMD}" "${COMMON_ARGS[@]}" "@${resolver_file}" "${BYPASS_RETRY_PROMPT}" > "${retry_output}" </dev/null; then
        log "Bypass retry done: ${retry_output}"
      else
        log "Bypass retry failed: ${retry_output}"
        log "Bypass phase failed."
        exit 1
      fi
    done < "${BYPASS_FAILURES_FILE}"
  fi
fi

ORCHESTRATOR_ARGS=("@${RUN_DIR}/tracer.md")
for resolver_file in "${RUN_DIR}"/resolver-*.md; do
  [[ -f "${resolver_file}" ]] && ORCHESTRATOR_ARGS+=("@${resolver_file}")
done
for bypass_file in "${RUN_DIR}"/bypass-*.md; do
  [[ -f "${bypass_file}" ]] && ORCHESTRATOR_ARGS+=("@${bypass_file}")
done

ORCHESTRATOR_PROMPT=$(cat <<EOF
You are the Orchestrator. Merge tracer/resolver/bypass handoffs into a pilot security review report. Use the chain-of-exploitation log template:
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

Also state whether the finding is validated (PoC) or a parking-lot candidate. Drop low-confidence items.
EOF
)

log "Starting orchestrator..."
"${PI_CMD}" "${COMMON_ARGS[@]}" "${ORCHESTRATOR_ARGS[@]}" "${ORCHESTRATOR_PROMPT}" > "${RUN_DIR}/orchestrator.md" </dev/null
log "Orchestrator done: ${RUN_DIR}/orchestrator.md"

log "Run complete: ${RUN_DIR}"
