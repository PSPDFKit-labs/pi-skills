import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_GUARDRAIL_MODE,
	buildGuardrailSystemPrompt,
	extractAssistantText,
	hasDiscreteChoicePrompt,
	isWorkflowComplete,
	persistGuardrailMode,
	reconstructGuardrailMode,
	validateCompletionResponse,
	type GuardrailMode,
} from "./core/guardrails";
import { buildKickoffPrompt, buildResumePrompt } from "./core/prompt";
import { TRACKER_ENTRY_TYPE, createInitialTrackerState } from "./core/state";
import type { DesignTrackerState } from "./core/types";
import { registerAskUserQuestionTool } from "./tools/ask-user-question";
import { registerDesignResearchFanoutTool } from "./tools/design-research-fanout";
import { reconstructTrackerState, registerDesignPlanTrackerTool } from "./tools/design-plan-tracker";
import { renderDesignPlanWidget } from "./ui/widget";

function persistTrackerState(pi: ExtensionAPI, state: DesignTrackerState | null): void {
	pi.appendEntry(TRACKER_ENTRY_TYPE, { state });
}

function refreshUi(ctx: ExtensionContext, state: DesignTrackerState | null): void {
	renderDesignPlanWidget({ ctx, state });
}

function normalizeGuardrailArg(arg: string): GuardrailMode | "status" | null {
	switch (arg.trim().toLowerCase()) {
		case "":
		case "status":
			return "status";
		case "strict":
		case "on":
			return "strict";
		case "relaxed":
		case "off":
			return "relaxed";
		default:
			return null;
	}
}

function guardrailStatusText(mode: GuardrailMode): string {
	return mode === "strict"
		? "strict (enforces ask_user_question for discrete options + strict completion shape)"
		: "relaxed (prompt-guided only)";
}

export default function startDesignPlanExtension(pi: ExtensionAPI): void {
	let state: DesignTrackerState | null = null;
	let guardrailMode: GuardrailMode = DEFAULT_GUARDRAIL_MODE;

	const setState = (next: DesignTrackerState | null): void => {
		state = next;
	};

	const setGuardrailMode = (next: GuardrailMode): void => {
		guardrailMode = next;
	};

	const onSessionEvent = (ctx: ExtensionContext): void => {
		state = reconstructTrackerState(ctx);
		guardrailMode = reconstructGuardrailMode(ctx);
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

	pi.on("before_agent_start", async (event) => {
		const guardrailPrompt = buildGuardrailSystemPrompt({
			mode: guardrailMode,
			state,
		});
		if (!guardrailPrompt) {
			return;
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${guardrailPrompt}`,
		};
	});

	pi.on("turn_end", async (event, ctx) => {
		if (guardrailMode !== "strict") return;
		if (!state) return;
		if (event.message.role !== "assistant") return;

		const assistantText = extractAssistantText(event.message);
		if (!assistantText) return;

		const workflowComplete = isWorkflowComplete(state);
		const usedAskUserQuestion = event.toolResults.some((result) => result.toolName === "ask_user_question");

		if (!workflowComplete) {
			if (!ctx.hasUI) return;
			if (!hasDiscreteChoicePrompt(assistantText)) return;
			if (usedAskUserQuestion) return;

			ctx.ui.notify("Guardrail: routing discrete options through ask_user_question", "warning");
			pi.sendUserMessage(
				[
					"Guardrail correction: you presented discrete options without ask_user_question.",
					"Re-ask the decision using ask_user_question with clear options (and allow Other).",
					"Do not proceed until that tool call is made.",
				].join("\n"),
				{ deliverAs: "followUp" },
			);
			return;
		}

		const completionValidation = validateCompletionResponse({ text: assistantText, state });
		if (completionValidation.ok) return;

		const designPath = state.designPath ?? "(unknown)";
		if (ctx.hasUI) {
			ctx.ui.notify(`Guardrail: rewriting completion response (${completionValidation.reason})`, "warning");
		}
		pi.sendUserMessage(
			[
				"Guardrail correction: rewrite the completion response now.",
				"Respond with exactly two lines and nothing else:",
				"Design planning is complete.",
				`Design path: ${designPath}`,
			].join("\n"),
			{ deliverAs: "followUp" },
		);
	});

	registerAskUserQuestionTool(pi);
	registerDesignResearchFanoutTool(pi);
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
			const topicInput = explicitTopic || (await ctx.ui.input("Design topic", "Short feature summary")) || "";
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

	pi.registerCommand("design-plan-guardrails", {
		description: "Set strict/relaxed guardrail mode for start-design-plan (usage: /design-plan-guardrails [strict|relaxed|status])",
		handler: async (args, ctx) => {
			const action = normalizeGuardrailArg(args);
			if (!action) {
				ctx.ui.notify("Invalid mode. Use strict, relaxed, or status.", "warning");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(`Design-plan guardrails: ${guardrailStatusText(guardrailMode)}`, "info");
				return;
			}

			setGuardrailMode(action);
			persistGuardrailMode(pi, action);
			ctx.ui.notify(`Design-plan guardrails set to ${guardrailStatusText(action)}`, "info");
		},
	});
}
