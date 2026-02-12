import fs from "node:fs/promises";
import { deriveCurrentPhaseId } from "./state";
import type { DesignTrackerState } from "./types";

const WORKFLOW_URL = new URL("../assets/workflow.md", import.meta.url);

const FALLBACK_WORKFLOW = `# Start Design Plan Workflow

Follow this five-phase process exactly:
1. Context Gathering
2. Clarification
3. Definition of Done
4. Brainstorming
5. Design Documentation

Use ask_user_question when presenting discrete options.
Use design_plan_tracker to create and update phase progress.
Use design_research_fanout before clarification and during brainstorming research checkpoints.

Do not skip phases.
Create docs/design-plans/YYYY-MM-DD-<slug>.md immediately after Definition of Done is confirmed.
When complete, report the design path and stop.`;

let cachedWorkflow: string | null = null;

async function getWorkflowText(): Promise<string> {
	if (cachedWorkflow !== null) {
		return cachedWorkflow;
	}

	try {
		const raw = await fs.readFile(WORKFLOW_URL, "utf8");
		cachedWorkflow = raw.trim() || FALLBACK_WORKFLOW;
	} catch {
		cachedWorkflow = FALLBACK_WORKFLOW;
	}

	return cachedWorkflow;
}

function buildTrackerSnapshotLines(state: DesignTrackerState): ReadonlyArray<string> {
	return state.phases.map((phase) => {
		const noteSuffix = phase.notes.length > 0 ? `; notes: ${phase.notes[phase.notes.length - 1]}` : "";
		return `- ${phase.id} (${phase.title}): ${phase.status}${noteSuffix}`;
	});
}

export async function buildKickoffPrompt(options: {
	readonly topic: string;
}): Promise<string> {
	const workflow = await getWorkflowText();

	return [
		"Run the /start-design-plan workflow for this topic:",
		`Topic: ${options.topic}`,
		"",
		"Execution requirements:",
		"- The tracker is already initialized by /start-design-plan. Call design_plan_tracker action=get first.",
		"- Update phase status and notes through every phase.",
		"- Run design_research_fanout before clarification questions and before proposing brainstorm approaches.",
		"- Track research/exploration tasks with design_plan_tracker add_task/set_task_status/append_task_note/list_tasks.",
		"- Use blockedBy dependencies for tasks that cannot start yet.",
		"- Use ask_user_question for structured choices.",
		"- Do not skip phases.",
		"- Create the design file in docs/design-plans once Definition of Done is confirmed.",
		"- End by reporting only that design is complete and the final design path.",
		"",
		"Workflow instructions:",
		workflow,
	].join("\n");
}

export async function buildResumePrompt(options: {
	readonly state: DesignTrackerState;
	readonly resumeInstruction?: string;
}): Promise<string> {
	const workflow = await getWorkflowText();
	const currentPhaseId = deriveCurrentPhaseId(options.state) ?? "unknown";
	const resumeInstruction = options.resumeInstruction?.trim();
	const designPath = options.state.designPath ?? "(not set yet)";

	return [
		"Resume the existing /start-design-plan workflow from current tracker state.",
		`Topic: ${options.state.topic}`,
		`Current phase id: ${currentPhaseId}`,
		`Design path: ${designPath}`,
		"",
		"Tracker snapshot:",
		...buildTrackerSnapshotLines(options.state),
		"",
		...(resumeInstruction ? ["Additional user instruction:", resumeInstruction, ""] : []),
		"Execution requirements:",
		"- Do not reset or recreate tracker state.",
		"- Call design_plan_tracker action=get first, then continue from the current phase.",
		"- Keep phase status transitions and notes current.",
		"- Run design_research_fanout at the same checkpoints as a fresh run (before clarification and brainstorming exploration).",
		"- Continue task graph tracking with add_task/set_task_status/append_task_note/list_tasks.",
		"- Use blockedBy dependencies for research/exploration sequencing.",
		"- Use ask_user_question for discrete decisions.",
		"- Continue until design-plan workflow reaches completion (after design documentation).",
		"",
		"Workflow instructions:",
		workflow,
	].join("\n");
}
