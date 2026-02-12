import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { DesignTrackerState } from "./types";

export type GuardrailMode = "strict" | "relaxed";

export const GUARDRAIL_ENTRY_TYPE = "start-design-plan-guardrail-mode";

export const DEFAULT_GUARDRAIL_MODE: GuardrailMode = "strict";

export function persistGuardrailMode(pi: ExtensionAPI, mode: GuardrailMode): void {
	pi.appendEntry(GUARDRAIL_ENTRY_TYPE, { mode });
}

export function reconstructGuardrailMode(ctx: ExtensionContext): GuardrailMode {
	let mode: GuardrailMode = DEFAULT_GUARDRAIL_MODE;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== GUARDRAIL_ENTRY_TYPE) continue;
		const data = entry.data as { readonly mode?: unknown } | undefined;
		if (data?.mode === "strict" || data?.mode === "relaxed") {
			mode = data.mode;
		}
	}
	return mode;
}

export function isWorkflowComplete(state: DesignTrackerState | null): boolean {
	if (!state) return false;
	if (state.phases.length === 0) return false;
	return state.phases.every((phase) => phase.status === "completed");
}

export function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	const parts = message.content
		.filter((item): item is { readonly type: "text"; readonly text: string } => item.type === "text")
		.map((item) => item.text.trim())
		.filter((item) => item.length > 0);
	return parts.join("\n\n").trim();
}

function normalizeLine(line: string): string {
	return line.trim().replace(/^[\-*]\s+/, "");
}

export function hasDiscreteChoicePrompt(text: string): boolean {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);

	if (lines.length === 0) return false;

	const numberedOptions = lines.filter((line) => /^\d+[.)]\s+\S+/.test(line)).length;
	const bulletOptions = lines.filter((line) => /^[-*]\s+\S+/.test(line)).length;
	const hasChoiceHeading = /(^|\n)\s*(options?|choices?)\s*[:\-]/i.test(text);
	const hasDecisionLanguage =
		/\b(which|what|choose|select|pick|preference|decide|should we|do you want|would you like)\b/i.test(text) ||
		text.includes("?");

	if (!hasDecisionLanguage) return false;
	if (numberedOptions >= 2) return true;
	if (hasChoiceHeading && numberedOptions + bulletOptions >= 2) return true;
	return false;
}

function escapeRegex(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function validateCompletionResponse(options: {
	readonly text: string;
	readonly state: DesignTrackerState;
}): { readonly ok: true } | { readonly ok: false; readonly reason: string } {
	if (!options.state.designPath) {
		return { ok: false, reason: "design path is not set" };
	}

	const forbidden = /\/clear|implementation\s+plan|start-implementation-plan|\/copy|copy\s+this\s+command/i;
	if (forbidden.test(options.text)) {
		return { ok: false, reason: "completion message includes forbidden handoff/copy guidance" };
	}

	const nonEmptyLines = options.text
		.split("\n")
		.map(normalizeLine)
		.filter((line) => line.length > 0);
	if (nonEmptyLines.length !== 2) {
		return { ok: false, reason: "completion message must contain exactly two non-empty lines" };
	}

	if (!/^design planning is complete\.?$/i.test(nonEmptyLines[0])) {
		return { ok: false, reason: "first line must state completion" };
	}

	const pathRegex = new RegExp(`^design path:\\s*` + "`?" + escapeRegex(options.state.designPath) + "`?$", "i");
	if (!pathRegex.test(nonEmptyLines[1])) {
		return { ok: false, reason: "second line must report exact design path" };
	}

	return { ok: true };
}

export function buildGuardrailSystemPrompt(options: {
	readonly mode: GuardrailMode;
	readonly state: DesignTrackerState | null;
}): string | null {
	if (options.mode !== "strict") return null;
	if (!options.state) return null;

	if (isWorkflowComplete(options.state) && options.state.designPath) {
		return [
			"start-design-plan strict completion guardrail:",
			"- Respond with exactly two lines and no extra text:",
			"  Design planning is complete.",
			`  Design path: ${options.state.designPath}`,
			"- Do not mention implementation planning, /clear, copy/paste commands, or any next steps.",
		].join("\n");
	}

	return [
		"start-design-plan strict choice guardrail:",
		"- Any discrete decision with 2+ options MUST use ask_user_question.",
		"- Do not present numbered or bulleted option menus directly in assistant text.",
		"- Before architecture-choice decisions, provide a short Research Digest with findings, risks, and evidence paths.",
		"- Keep open-ended questions to a single question at a time.",
	].join("\n");
}
