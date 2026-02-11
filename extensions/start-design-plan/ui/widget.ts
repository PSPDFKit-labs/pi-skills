import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DesignTrackerState } from "../core/types";
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
		default:
			return "○";
	}
}

function countCompleted(state: DesignTrackerState): number {
	return state.phases.filter((phase) => phase.status === "completed").length;
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

	const lines = [
		ctx.ui.theme.fg("accent", `Design Plan: ${state.topic}`),
		ctx.ui.theme.fg("dim", `Progress: ${completed}/${total} complete`),
		...state.phases.map((phase) => {
			const icon = iconForStatus(phase.status);
			const title = `${icon} ${phase.title}`;
			const isCurrent = current !== null && phase.id === current;
			const color = phase.status === "completed" ? "success" : phase.status === "blocked" ? "warning" : "text";
			return isCurrent
				? ctx.ui.theme.fg("accent", `${title} (current)`)
				: ctx.ui.theme.fg(color, title);
		}),
	];

	ctx.ui.setWidget("start-design-plan", lines);
	ctx.ui.setStatus(
		"start-design-plan",
		ctx.ui.theme.fg("dim", `design ${completed}/${total} • current ${current ?? "none"}`),
	);
}
