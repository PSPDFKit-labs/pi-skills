import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DesignTask, DesignTrackerState } from "../core/types";
import { deriveCurrentPhaseId } from "../core/state";

type RenderDesignPlanWidgetOptions = {
	readonly ctx: ExtensionContext;
	readonly state: DesignTrackerState | null;
};

function iconForStatus(status: string): string {
	switch (status) {
		case "completed":
			return "✓";
		case "in_progress":
			return "▶";
		case "blocked":
			return "!";
		case "failed":
			return "✗";
		default:
			return "○";
	}
}

function countCompleted(state: DesignTrackerState): number {
	return state.phases.filter((phase) => phase.status === "completed").length;
}

function summarizeTasks(tasks: ReadonlyArray<DesignTask>): string {
	if (tasks.length === 0) return "no tasks";
	const completed = tasks.filter((task) => task.status === "completed").length;
	const blocked = tasks.filter((task) => task.status === "blocked").length;
	const inProgress = tasks.filter((task) => task.status === "in_progress").length;
	const failed = tasks.filter((task) => task.status === "failed").length;
	const segments: Array<string> = [`${completed}/${tasks.length} done`];
	if (inProgress > 0) segments.push(`${inProgress} in progress`);
	if (blocked > 0) segments.push(`${blocked} blocked`);
	if (failed > 0) segments.push(`${failed} failed`);
	return segments.join(" • ");
}

function taskLinesForPhase(options: {
	readonly ctx: ExtensionContext;
	readonly phaseId: string;
	readonly tasks: ReadonlyArray<DesignTask>;
}): ReadonlyArray<string> {
	const phaseTasks = options.tasks.filter((task) => task.phaseId === options.phaseId);
	if (phaseTasks.length === 0) {
		return [options.ctx.ui.theme.fg("dim", "Tasks: no tasks")];
	}

	const sorted = [...phaseTasks].sort((left, right) => left.id.localeCompare(right.id));
	const preview = sorted.slice(0, 3).map((task) => {
		const icon = iconForStatus(task.status);
		const owner = task.owner ? ` @${task.owner}` : "";
		const blockedBy = task.blockedBy.length > 0 ? ` ← ${task.blockedBy.join(",")}` : "";
		return options.ctx.ui.theme.fg("muted", `${icon} ${task.id}: ${task.title}${owner}${blockedBy}`);
	});
	if (sorted.length > 3) {
		preview.push(options.ctx.ui.theme.fg("dim", `… ${sorted.length - 3} more tasks`));
	}
	return [options.ctx.ui.theme.fg("muted", `Tasks: ${summarizeTasks(phaseTasks)}`), ...preview];
}

export function renderDesignPlanWidget(options: RenderDesignPlanWidgetOptions): void {
	const { ctx, state } = options;
	if (!ctx.hasUI) return;

	if (!state) {
		ctx.ui.setWidget("start-design-plan", undefined);
		ctx.ui.setStatus("start-design-plan", undefined);
		return;
	}

	const current = deriveCurrentPhaseId(state);
	const completed = countCompleted(state);
	const total = state.phases.length;
	const isComplete = completed === total && total > 0;

	if (isComplete) {
		ctx.ui.setWidget("start-design-plan", undefined);
		ctx.ui.setStatus("start-design-plan", undefined);
		return;
	}

	const currentPhaseId = current ?? "none";
	const currentTasks = current ? state.tasks.filter((task) => task.phaseId === current) : [];

	const lines = [
		ctx.ui.theme.fg("accent", `Design Plan: ${state.topic}`),
		ctx.ui.theme.fg("dim", `Progress: ${completed}/${total} complete`),
		...state.phases.map((phase) => {
			const icon = iconForStatus(phase.status);
			const title = `${icon} ${phase.title}`;
			const isCurrent = current !== null && phase.id === current;
			const color = phase.status === "completed" ? "success" : phase.status === "blocked" ? "warning" : "text";
			return isCurrent ? ctx.ui.theme.fg("accent", `${title} (current)`) : ctx.ui.theme.fg(color, title);
		}),
		...(current ? taskLinesForPhase({ ctx, phaseId: current, tasks: state.tasks }) : []),
	];

	ctx.ui.setWidget("start-design-plan", lines);
	ctx.ui.setStatus(
		"start-design-plan",
		ctx.ui.theme.fg(
			"dim",
			`design ${completed}/${total} • current ${currentPhaseId} • ${summarizeTasks(currentTasks)}`,
		),
	);
}
