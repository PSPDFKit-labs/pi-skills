import type { Api, Model } from "@mariozechner/pi-ai";
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
import {
	DEFAULT_DESIGN_PLAN_CONFIG,
	persistDesignPlanConfig,
	reconstructDesignPlanConfig,
	withDesignPlanConfigPatch,
	type DesignPlanConfig,
} from "./core/config";
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

function parseBooleanArg(value: string): boolean | null {
	switch (value.trim().toLowerCase()) {
		case "true":
		case "on":
		case "yes":
		case "1":
			return true;
		case "false":
		case "off":
		case "no":
		case "0":
			return false;
		default:
			return null;
	}
}

function formatConfigSummary(config: DesignPlanConfig): string {
	return [
		`model=${config.researchModel ?? "default"}`,
		`maxAgents=${config.researchMaxAgents}`,
		`includeInternet=${config.researchIncludeInternet ? "on" : "off"}`,
	].join(" • ");
}

type SelectOption<TValue> = {
	readonly label: string;
	readonly value: TValue;
};

async function selectOption<TValue>(options: {
	readonly ctx: ExtensionContext;
	readonly title: string;
	readonly items: ReadonlyArray<SelectOption<TValue>>;
}): Promise<TValue | undefined> {
	if (!options.ctx.hasUI) return undefined;
	if (options.items.length === 0) return undefined;

	const labels = options.items.map((item) => item.label);
	const selected = await options.ctx.ui.select(options.title, labels);
	if (!selected) return undefined;

	const index = labels.findIndex((label) => label === selected);
	if (index < 0) return undefined;
	return options.items[index].value;
}

function buildModelSelectorOptions(options: {
	readonly availableModels: ReadonlyArray<Model<Api>>;
	readonly currentModel: string | null;
}): ReadonlyArray<SelectOption<string | null>> {
	const byId = new Map<string, Model<Api>>();
	for (const model of options.availableModels) {
		if (!byId.has(model.id)) {
			byId.set(model.id, model);
		}
	}

	const sortedModels = Array.from(byId.values()).sort((left, right) => {
		const providerCompare = left.provider.localeCompare(right.provider);
		if (providerCompare !== 0) return providerCompare;
		return left.name.localeCompare(right.name);
	});

	const items: Array<SelectOption<string | null>> = [
		{ label: "Default (no model override)", value: null },
		...sortedModels.map((model) => ({
			label: `${model.provider}/${model.id} — ${model.name}`,
			value: model.id,
		})),
	];

	if (options.currentModel && !byId.has(options.currentModel)) {
		items.splice(1, 0, {
			label: `Current custom model (${options.currentModel})`,
			value: options.currentModel,
		});
	}

	return items;
}

export default function startDesignPlanExtension(pi: ExtensionAPI): void {
	let state: DesignTrackerState | null = null;
	let guardrailMode: GuardrailMode = DEFAULT_GUARDRAIL_MODE;
	let config: DesignPlanConfig = DEFAULT_DESIGN_PLAN_CONFIG;

	const setState = (next: DesignTrackerState | null): void => {
		state = next;
	};

	const setGuardrailMode = (next: GuardrailMode): void => {
		guardrailMode = next;
	};

	const setConfig = (next: DesignPlanConfig): void => {
		config = next;
	};

	const saveConfig = (next: DesignPlanConfig): void => {
		setConfig(next);
		persistDesignPlanConfig(pi, next);
	};

	const applyConfigPatch = (patch: Partial<Omit<DesignPlanConfig, "version">>): DesignPlanConfig => {
		const next = withDesignPlanConfigPatch({ config, patch });
		saveConfig(next);
		return next;
	};

	const onSessionEvent = (ctx: ExtensionContext): void => {
		state = reconstructTrackerState(ctx);
		guardrailMode = reconstructGuardrailMode(ctx);
		config = reconstructDesignPlanConfig(ctx);
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
	registerDesignResearchFanoutTool(pi, {
		getConfig: () => config,
	});
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

	pi.registerCommand("design-plan-config", {
		description:
			"Configure start-design-plan defaults. No args opens interactive UI. Text mode: [status|reset|model <id|default>|max-agents <1-4>|include-internet <on|off>]",
		handler: async (args, ctx) => {
			const tokens = args
				.trim()
				.split(/\s+/)
				.filter((token) => token.length > 0);

			if (tokens.length === 0 && ctx.hasUI) {
				const action = await selectOption({
					ctx,
					title: `Design plan config (${formatConfigSummary(config)})`,
					items: [
						{ label: "Set research model", value: "model" as const },
						{ label: "Set max research agents", value: "max-agents" as const },
						{ label: "Toggle include internet", value: "include-internet" as const },
						{ label: "Reset defaults", value: "reset" as const },
						{ label: "Show current status", value: "status" as const },
					],
				});
				if (!action) return;

				if (action === "model") {
					const modelOptions = buildModelSelectorOptions({
						availableModels: ctx.modelRegistry.getAvailable(),
						currentModel: config.researchModel,
					});
					const selectedModel = await selectOption({
						ctx,
						title: "Select research model",
						items: modelOptions,
					});
					if (selectedModel === undefined) return;
					const next = applyConfigPatch({ researchModel: selectedModel });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				if (action === "max-agents") {
					const selectedMaxAgents = await selectOption({
						ctx,
						title: "Select max research agents",
						items: [
							{ label: "1", value: 1 },
							{ label: "2", value: 2 },
							{ label: "3", value: 3 },
							{ label: "4", value: 4 },
						],
					});
					if (selectedMaxAgents === undefined) return;
					const next = applyConfigPatch({ researchMaxAgents: selectedMaxAgents });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				if (action === "include-internet") {
					const selectedIncludeInternet = await selectOption({
						ctx,
						title: "Include internet research by default?",
						items: [
							{ label: "On", value: true },
							{ label: "Off", value: false },
						],
					});
					if (selectedIncludeInternet === undefined) return;
					const next = applyConfigPatch({ researchIncludeInternet: selectedIncludeInternet });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				if (action === "reset") {
					saveConfig(DEFAULT_DESIGN_PLAN_CONFIG);
					ctx.ui.notify(`Design-plan config reset: ${formatConfigSummary(DEFAULT_DESIGN_PLAN_CONFIG)}`, "info");
					return;
				}

				ctx.ui.notify(`Design-plan config: ${formatConfigSummary(config)}`, "info");
				return;
			}

			const action = tokens[0]?.toLowerCase() ?? "status";

			if (action === "status") {
				ctx.ui.notify(`Design-plan config: ${formatConfigSummary(config)}`, "info");
				return;
			}

			if (action === "reset") {
				saveConfig(DEFAULT_DESIGN_PLAN_CONFIG);
				ctx.ui.notify(`Design-plan config reset: ${formatConfigSummary(DEFAULT_DESIGN_PLAN_CONFIG)}`, "info");
				return;
			}

			if (action === "model") {
				const modelValue = tokens.slice(1).join(" ").trim();
				if (modelValue.length === 0 && ctx.hasUI) {
					const modelOptions = buildModelSelectorOptions({
						availableModels: ctx.modelRegistry.getAvailable(),
						currentModel: config.researchModel,
					});
					const selectedModel = await selectOption({
						ctx,
						title: "Select research model",
						items: modelOptions,
					});
					if (selectedModel === undefined) return;
					const next = applyConfigPatch({ researchModel: selectedModel });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				const nextModel =
					modelValue.length === 0 ||
					modelValue.toLowerCase() === "default" ||
					modelValue.toLowerCase() === "none" ||
					modelValue.toLowerCase() === "null"
						? null
						: modelValue;
				const next = applyConfigPatch({ researchModel: nextModel });
				ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
				return;
			}

			if (action === "max-agents") {
				if (!tokens[1] && ctx.hasUI) {
					const selectedMaxAgents = await selectOption({
						ctx,
						title: "Select max research agents",
						items: [
							{ label: "1", value: 1 },
							{ label: "2", value: 2 },
							{ label: "3", value: 3 },
							{ label: "4", value: 4 },
						],
					});
					if (selectedMaxAgents === undefined) return;
					const next = applyConfigPatch({ researchMaxAgents: selectedMaxAgents });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				const raw = tokens[1] ?? "";
				const parsed = Number.parseInt(raw, 10);
				if (!Number.isFinite(parsed) || parsed < 1 || parsed > 4) {
					ctx.ui.notify("Invalid max-agents. Use a number between 1 and 4.", "warning");
					return;
				}
				const next = applyConfigPatch({ researchMaxAgents: parsed });
				ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
				return;
			}

			if (action === "include-internet") {
				if (!tokens[1] && ctx.hasUI) {
					const selectedIncludeInternet = await selectOption({
						ctx,
						title: "Include internet research by default?",
						items: [
							{ label: "On", value: true },
							{ label: "Off", value: false },
						],
					});
					if (selectedIncludeInternet === undefined) return;
					const next = applyConfigPatch({ researchIncludeInternet: selectedIncludeInternet });
					ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
					return;
				}

				const value = parseBooleanArg(tokens[1] ?? "");
				if (value === null) {
					ctx.ui.notify("Invalid include-internet value. Use on/off.", "warning");
					return;
				}
				const next = applyConfigPatch({ researchIncludeInternet: value });
				ctx.ui.notify(`Design-plan config updated: ${formatConfigSummary(next)}`, "info");
				return;
			}

			ctx.ui.notify(
				"Invalid config command. Use status, reset, model, max-agents, or include-internet.",
				"warning",
			);
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
