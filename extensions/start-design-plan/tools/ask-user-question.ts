import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type AskOption = {
	readonly label: string;
	readonly description?: string;
};

type AskResultDetails = {
	readonly question: string;
	readonly options: ReadonlyArray<string>;
	readonly answer: string | null;
	readonly selectedIndex: number | null;
	readonly source: "option" | "other" | "cancelled";
};

const OPTION_SCHEMA = Type.Object({
	label: Type.String({ description: "Option label" }),
	description: Type.Optional(Type.String({ description: "Optional trade-off or context" })),
});

const ASK_PARAMS = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	options: Type.Array(OPTION_SCHEMA, { description: "Discrete options to present" }),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Allow custom response (default: true)", default: true }),
	),
	otherLabel: Type.Optional(Type.String({ description: "Label for custom response option" })),
});

function formatOption(option: AskOption, index: number): string {
	const prefix = `${index + 1}. ${option.label}`;
	if (!option.description?.trim()) {
		return prefix;
	}
	return `${prefix} — ${option.description.trim()}`;
}

function buildCancelledResult(options: {
	readonly question: string;
	readonly labels: ReadonlyArray<string>;
}): { readonly content: string; readonly details: AskResultDetails } {
	return {
		content: "User cancelled question",
		details: {
			question: options.question,
			options: options.labels,
			answer: null,
			selectedIndex: null,
			source: "cancelled",
		},
	};
}

export function registerAskUserQuestionTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask the user a structured question with discrete options. Prefer this tool when a decision has 2-4 clear choices. Includes an Other option by default for custom input.",
		parameters: ASK_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: ask_user_question requires interactive UI mode" }],
					isError: true,
					details: {
						question: params.question,
						options: params.options.map((option: AskOption) => option.label),
						answer: null,
						selectedIndex: null,
						source: "cancelled",
					},
				};
			}

			const question = params.question.trim();
			if (!question) {
				return {
					content: [{ type: "text", text: "Error: question must not be empty" }],
					isError: true,
				};
			}

			const options = (params.options as Array<AskOption>).filter((option) => option.label.trim().length > 0);
			const allowOther = params.allowOther !== false;
			const otherLabel = params.otherLabel?.trim() || "Other…";
			if (options.length === 0 && !allowOther) {
				return {
					content: [{ type: "text", text: "Error: at least one option is required unless allowOther=true" }],
					isError: true,
				};
			}

			const rendered = options.map((option, index) => formatOption(option, index));
			const menu = allowOther ? [...rendered, `${rendered.length + 1}. ${otherLabel}`] : rendered;
			const selected = await ctx.ui.select(question, menu);
			if (!selected) {
				const cancelled = buildCancelledResult({
					question,
					labels: options.map((option) => option.label),
				});
				return {
					content: [{ type: "text", text: cancelled.content }],
					details: cancelled.details,
				};
			}

			const selectedIndex = menu.findIndex((item) => item === selected);
			const selectedOption = selectedIndex >= 0 && selectedIndex < options.length ? options[selectedIndex] : null;
			if (selectedOption) {
				const details: AskResultDetails = {
					question,
					options: options.map((option) => option.label),
					answer: selectedOption.label,
					selectedIndex,
					source: "option",
				};
				return {
					content: [{ type: "text", text: `User selected: ${selectedOption.label}` }],
					details,
				};
			}

			if (!allowOther) {
				return {
					content: [{ type: "text", text: "User selection was not recognized" }],
					isError: true,
				};
			}

			const response = await ctx.ui.editor(question, "");
			if (!response?.trim()) {
				const cancelled = buildCancelledResult({
					question,
					labels: options.map((option) => option.label),
				});
				return {
					content: [{ type: "text", text: cancelled.content }],
					details: cancelled.details,
				};
			}

			const answer = response.trim();
			const details: AskResultDetails = {
				question,
				options: options.map((option) => option.label),
				answer,
				selectedIndex: null,
				source: "other",
			};
			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details,
			};
		},
		renderCall(args, theme) {
			const optionCount = Array.isArray(args.options) ? args.options.length : 0;
			const header = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			return new Text(`${header}\n${theme.fg("dim", `options: ${optionCount}`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.source === "cancelled") {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const prefix = details.source === "other" ? "custom" : "selected";
			return new Text(theme.fg("success", `✓ ${prefix}: ${details.answer ?? ""}`), 0, 0);
		},
	});
}
