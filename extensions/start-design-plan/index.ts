import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildKickoffPrompt, buildResumePrompt } from "./core/prompt";
import { TRACKER_ENTRY_TYPE, createInitialTrackerState } from "./core/state";
import type { DesignTrackerState } from "./core/types";
import { registerAskUserQuestionTool } from "./tools/ask-user-question";
import { reconstructTrackerState, registerDesignPlanTrackerTool } from "./tools/design-plan-tracker";
import { renderDesignPlanWidget } from "./ui/widget";

function persistTrackerState(pi: ExtensionAPI, state: DesignTrackerState | null): void {
	pi.appendEntry(TRACKER_ENTRY_TYPE, { state });
}

function refreshUi(ctx: ExtensionContext, state: DesignTrackerState | null): void {
	renderDesignPlanWidget({ ctx, state });
}

export default function startDesignPlanExtension(pi: ExtensionAPI): void {
	let state: DesignTrackerState | null = null;

	const setState = (next: DesignTrackerState | null): void => {
		state = next;
	};

	const onSessionEvent = (ctx: ExtensionContext): void => {
		state = reconstructTrackerState(ctx);
		refreshUi(ctx, state);
	};

	pi.on("session_start", async (_event, ctx) => {
		onSessionEvent(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		onSessionEvent(ctx);
	});

	pi.on("session_tree", async (_event, ctx) => {
		onSessionEvent(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("start-design-plan", undefined);
		ctx.ui.setStatus("start-design-plan", undefined);
	});

	registerAskUserQuestionTool(pi);
	registerDesignPlanTrackerTool(pi, {
		getState: () => state,
		setState,
		onChange: (ctx) => {
			refreshUi(ctx, state);
		},
	});

	pi.registerCommand("start-design-plan", {
		description: "Run the five-phase design workflow and write docs/design-plans/YYYY-MM-DD-<slug>.md",
		handler: async (args, ctx) => {
			const explicitTopic = args.trim();
			const topicInput =
				explicitTopic ||
				(await ctx.ui.input("Design topic", "Short feature summary")) ||
				"";
			const topic = topicInput.trim();
			if (!topic) {
				ctx.ui.notify("Cancelled: topic is required", "warning");
				return;
			}

			if (state) {
				const replace = await ctx.ui.confirm(
					"Replace existing design tracker?",
					"A design-plan tracker is already active. Replace it and start a new workflow?",
				);
				if (!replace) {
					ctx.ui.notify("Start design plan cancelled", "info");
					return;
				}
			}

			const nowIso = new Date().toISOString();
			const created = createInitialTrackerState({ topic, nowIso });
			if (!created.ok) {
				ctx.ui.notify(created.error, "error");
				return;
			}

			setState(created.state);
			persistTrackerState(pi, created.state);
			refreshUi(ctx, created.state);

			const kickoffPrompt = await buildKickoffPrompt({ topic });
			pi.sendUserMessage(kickoffPrompt);
			ctx.ui.notify("Design workflow started", "info");
		},
	});

	pi.registerCommand("resume-design-plan", {
		description: "Resume an in-progress design workflow from stored tracker state",
		handler: async (args, ctx) => {
			if (!state) {
				ctx.ui.notify("No active design tracker found. Start one with /start-design-plan.", "warning");
				return;
			}

			const resumeInstruction = args.trim() || undefined;
			const resumePrompt = await buildResumePrompt({
				state,
				resumeInstruction,
			});
			pi.sendUserMessage(resumePrompt);
			ctx.ui.notify("Resuming design workflow", "info");
		},
	});
}
