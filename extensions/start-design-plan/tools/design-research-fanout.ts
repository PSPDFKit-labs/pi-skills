import { spawn } from "node:child_process";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { DesignPlanConfig } from "../core/config";

type ResearchPhase = "context" | "brainstorm";
type ResearchMode = "codebase" | "internet" | "hybrid";
type ResearchRole = "investigator" | "analyst" | "researcher";

type ResearchTask = {
	readonly id: string;
	readonly label: string;
	readonly role: ResearchRole;
	readonly goal: string;
	readonly mode: ResearchMode;
	readonly deliverable: string;
};

type ResearchTaskResult = {
	readonly id: string;
	readonly label: string;
	readonly role: ResearchRole;
	readonly goal: string;
	readonly mode: ResearchMode;
	readonly deliverable: string;
	readonly status: "running" | "done" | "error";
	readonly summary: string;
	readonly startedAt: string;
	readonly finishedAt: string | null;
	readonly durationMs: number | null;
	readonly model: string | null;
	readonly error?: string;
};

type ResearchDetails = {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly model: string | null;
	readonly launched: number;
	readonly completed: number;
	readonly results: ReadonlyArray<ResearchTaskResult>;
};

type ResearchFanoutBinding = {
	readonly getConfig: () => DesignPlanConfig;
};

const PHASE_SCHEMA = StringEnum(["context", "brainstorm"] as const, {
	description: "Research phase",
});

const MODE_SCHEMA = StringEnum(["codebase", "internet", "hybrid"] as const, {
	description: "Research mode",
});

const ROLE_SCHEMA = StringEnum(["investigator", "analyst", "researcher"] as const, {
	description: "Subagent role",
});

const CUSTOM_ROLE_SCHEMA = Type.Object({
	label: Type.String({ description: "Display label for this role" }),
	role: ROLE_SCHEMA,
	goal: Type.String({ description: "Research goal for this role" }),
	mode: MODE_SCHEMA,
	deliverable: Type.Optional(Type.String({ description: "Expected output artifact from this role" })),
});

const RESEARCH_PARAMS = Type.Object({
	phase: PHASE_SCHEMA,
	topic: Type.String({ description: "Design topic under investigation" }),
	goals: Type.Optional(Type.Array(Type.String({ description: "Specific research goal" }))),
	roles: Type.Optional(
		Type.Array(CUSTOM_ROLE_SCHEMA, {
			description: "Optional explicit role assignments. Overrides default phase roles.",
			minItems: 1,
			maxItems: 6,
		}),
	),
	includeInternet: Type.Optional(
		Type.Boolean({
			description: "Include internet-oriented tasks (overrides /design-plan-config setting)",
			default: true,
		}),
	),
	maxAgents: Type.Optional(
		Type.Number({
			description: "Maximum concurrent agents 1-4 (overrides /design-plan-config setting)",
			minimum: 1,
			maximum: 4,
			default: 3,
		}),
	),
	model: Type.Optional(
		Type.String({
			description: "Model id for all research agents (overrides /design-plan-config setting)",
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory override for research subprocesses" })),
});

function normalizeLabel(label: string, fallbackIndex: number): string {
	const trimmed = label.trim().toLowerCase();
	if (!trimmed) return `role-${fallbackIndex + 1}`;
	const normalized = trimmed.replace(/[^a-z0-9-]+/g, "-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
	return normalized.length > 0 ? normalized : `role-${fallbackIndex + 1}`;
}

function truncateText(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) return normalized;
	return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function goalPreview(goal: string, maxLength = 72): string {
	return truncateText(goal, maxLength);
}

function goalLabelFromText(goal: string, fallbackIndex: number): string {
	const tokens = goal
		.toLowerCase()
		.replace(/[^a-z0-9\s-]+/g, " ")
		.split(/\s+/)
		.filter((token) => token.length > 0)
		.slice(0, 4);
	const core = tokens.join("-").replace(/-{2,}/g, "-").replace(/^-|-$/g, "");
	if (!core) return `research-${fallbackIndex + 1}`;
	return `research-${fallbackIndex + 1}-${core.slice(0, 28)}`;
}

function buildDefaultTasks(options: {
	readonly phase: ResearchPhase;
	readonly includeInternet: boolean;
}): ReadonlyArray<ResearchTask> {
	if (options.phase === "context") {
		const tasks: Array<ResearchTask> = [
			{
				id: "context-codebase-investigator",
				label: "codebase-investigator",
				role: "investigator",
				goal: "Identify relevant files, symbols, and existing implementation patterns for this topic.",
				mode: "codebase",
				deliverable: "Annotated map of existing code paths and pattern references.",
			},
			{
				id: "context-constraints-analyst",
				label: "constraints-analyst",
				role: "analyst",
				goal: "Identify architectural constraints, integration boundaries, and dependency risks.",
				mode: "hybrid",
				deliverable: "Constraint and risk matrix with explicit unknowns.",
			},
		];

		if (options.includeInternet) {
			tasks.push({
				id: "context-external-researcher",
				label: "external-researcher",
				role: "researcher",
				goal: "Identify relevant external standards, best practices, and common failure modes.",
				mode: "internet",
				deliverable: "External references and anti-pattern checklist relevant to this design.",
			});
		}

		return tasks;
	}

	const tasks: Array<ResearchTask> = [
		{
			id: "brainstorm-critical-path-investigator",
			label: "critical-path-investigator",
			role: "investigator",
			goal: "Identify performance-sensitive and complexity-critical areas that constrain design choices.",
			mode: "codebase",
			deliverable: "Critical path report with concrete hotspots and coupling points.",
		},
		{
			id: "brainstorm-alternatives-analyst",
			label: "alternatives-analyst",
			role: "analyst",
			goal: "Evaluate 2-3 viable architecture alternatives grounded in current codebase constraints.",
			mode: "hybrid",
			deliverable: "Trade-off matrix covering complexity, risk, and maintainability.",
		},
	];

	if (options.includeInternet) {
		tasks.push({
			id: "brainstorm-industry-researcher",
			label: "industry-researcher",
			role: "researcher",
			goal: "Find external benchmark patterns and practical lessons that can influence approach selection.",
			mode: "internet",
			deliverable: "Comparative benchmark notes with references and applicability caveats.",
		});
	}

	return tasks;
}

function buildGoalTasks(goals: ReadonlyArray<string>): ReadonlyArray<ResearchTask> {
	return goals.map((goal, index) => {
		const label = goalLabelFromText(goal, index);
		return {
			id: `goal-${index + 1}-${label}`,
			label,
			role: "analyst",
			goal,
			mode: "hybrid",
			deliverable: "Focused findings and recommendation for assigned goal.",
		};
	});
}

function buildCustomRoleTasks(roles: ReadonlyArray<{
	readonly label: string;
	readonly role: ResearchRole;
	readonly goal: string;
	readonly mode: ResearchMode;
	readonly deliverable?: string;
}>): ReadonlyArray<ResearchTask> {
	return roles.map((role, index) => {
		const label = normalizeLabel(role.label, index);
		const goal = role.goal.trim();
		const deliverable = role.deliverable?.trim();

		return {
			id: `${label}-${index + 1}`,
			label,
			role: role.role,
			goal,
			mode: role.mode,
			deliverable: deliverable && deliverable.length > 0 ? deliverable : "Focused findings and recommendation.",
		};
	});
}

function buildResearchPrompt(options: {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly task: ResearchTask;
}): string {
	const modeHint =
		options.task.mode === "codebase"
			? "Prioritize codebase inspection (files, symbols, dependencies, interfaces)."
			: options.task.mode === "internet"
				? "Prioritize external standards/docs. If internet tools are unavailable, state that explicitly and continue with local evidence."
				: "Use both codebase evidence and external references where relevant.";

	return [
		`You are ${options.task.label}, acting as a ${options.task.role} subagent in a coordinated research fanout.`,
		`Phase: ${options.phase}`,
		`Topic: ${options.topic}`,
		`Assigned goal: ${options.task.goal}`,
		`Expected deliverable: ${options.task.deliverable}`,
		"",
		"Subagent operating contract:",
		"- Stay focused on your assigned goal; do not solve unrelated design decisions.",
		"- Prefer concrete evidence over speculation.",
		"- Include file paths and symbol names for codebase claims.",
		"- Surface contradictions and unknowns clearly.",
		"- End with a concise recommendation that another agent could consume.",
		"",
		modeHint,
		"",
		"Output format (exact headings):",
		"## Agent Identity",
		`- label: ${options.task.label}`,
		`- role: ${options.task.role}`,
		"",
		"## Findings",
		"- concise bullets",
		"",
		"## Evidence",
		"- concrete file paths / symbols / references",
		"",
		"## Risks & Unknowns",
		"- unresolved assumptions and data gaps",
		"",
		"## Recommendation",
		"- practical guidance for design planning",
		"",
		"## Handoff",
		"- what the next role should verify",
	].join("\n");
}

function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const role = (message as { readonly role?: unknown }).role;
	if (role !== "assistant") return "";
	const content = (message as { readonly content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const parts = content
		.filter((item): item is { readonly type: "text"; readonly text: string } => {
			if (!item || typeof item !== "object") return false;
			const type = (item as { readonly type?: unknown }).type;
			const text = (item as { readonly text?: unknown }).text;
			return type === "text" && typeof text === "string";
		})
		.map((item) => item.text);
	return parts.join("\n").trim();
}

function firstSummaryLine(summary: string): string {
	const lines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (lines.length === 0) return "no summary";

	const firstMeaningful = lines.find((line) => !line.startsWith("##"));
	if (!firstMeaningful) return lines[0];
	return firstMeaningful.length > 120 ? `${firstMeaningful.slice(0, 120)}…` : firstMeaningful;
}

function formatDuration(durationMs: number | null): string {
	if (durationMs === null || durationMs < 0) return "n/a";
	if (durationMs < 1000) return `${durationMs}ms`;
	const seconds = Math.round(durationMs / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function buildProgressText(details: ResearchDetails): string {
	const modelSuffix = details.model ? ` • model ${details.model}` : "";
	const lines: Array<string> = [
		`Research fanout (${details.phase}) ${details.completed}/${details.launched} complete${modelSuffix}`,
	];
	for (const result of details.results) {
		const statusIcon = result.status === "done" ? "✓" : result.status === "error" ? "✗" : "⏳";
		const goal = ` — goal: ${goalPreview(result.goal, 64)}`;
		const suffix =
			result.status === "error"
				? ` — ${result.error ?? "failed"}`
				: result.status === "done"
					? ` — ${firstSummaryLine(result.summary)}`
					: "";
		lines.push(`${statusIcon} ${result.label} (${result.role})${goal}${suffix}`);
	}
	return lines.join("\n");
}

function extractSignalKeywords(summary: string): ReadonlyArray<string> {
	const lines = summary
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("-") || line.startsWith("*"));
	if (lines.length === 0) return [];
	return lines.slice(0, 2).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter((line) => line.length > 0);
}

function buildSynthesis(details: ResearchDetails): string {
	const completed = details.results.filter((result) => result.status === "done");
	const failed = details.results.filter((result) => result.status === "error");

	const digestLines = completed.map((result) => {
		const signals = extractSignalKeywords(result.summary);
		if (signals.length === 0) {
			return `- ${result.label} (${result.role}): ${firstSummaryLine(result.summary)}`;
		}
		return `- ${result.label} (${result.role}): ${signals.join(" | ")}`;
	});

	const riskLines = failed.map((result) => `- ${result.label}: ${result.error ?? "failed"}`);

	const nextStepHints = completed
		.map((result) => {
			const lines = result.summary
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
			const handoffIndex = lines.findIndex((line) => /^##\s+handoff/i.test(line));
			if (handoffIndex < 0) return null;
			const handoffBullet = lines
				.slice(handoffIndex + 1)
				.find((line) => line.startsWith("-") || line.startsWith("*"));
			if (!handoffBullet) return null;
			return `- ${result.label}: ${handoffBullet.replace(/^[-*]\s*/, "").trim()}`;
		})
		.filter((line): line is string => Boolean(line));

	return [
		"## Cross-Agent Synthesis",
		digestLines.length > 0 ? digestLines.join("\n") : "- no completed role outputs",
		"",
		"## Outstanding Gaps",
		riskLines.length > 0 ? riskLines.join("\n") : "- none reported",
		"",
		"## Suggested Next Checks",
		nextStepHints.length > 0 ? nextStepHints.join("\n") : "- proceed with clarification/brainstorming using the synthesized findings",
	].join("\n");
}

async function runResearchTask(options: {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly task: ResearchTask;
	readonly cwd: string;
	readonly model: string | null;
	readonly signal?: AbortSignal;
}): Promise<ResearchTaskResult> {
	const prompt = buildResearchPrompt({
		phase: options.phase,
		topic: options.topic,
		task: options.task,
	});

	const startedAt = new Date().toISOString();

	return await new Promise<ResearchTaskResult>((resolve) => {
		const args = ["--mode", "json", "-p", "--no-session"];
		if (options.model) {
			args.push("--model", options.model);
		}
		args.push(prompt);
		const proc = spawn("pi", args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let latestAssistant = "";
		let aborted = false;
		let settled = false;

		const abortHandler = (): void => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGKILL");
				}
			}, 2000);
		};

		const settle = (result: {
			readonly status: "done" | "error";
			readonly summary: string;
			readonly error?: string;
		}): void => {
			if (settled) return;
			settled = true;
			if (options.signal) {
				options.signal.removeEventListener("abort", abortHandler);
			}
			const finishedAt = new Date().toISOString();
			resolve({
				id: options.task.id,
				label: options.task.label,
				role: options.task.role,
				goal: options.task.goal,
				mode: options.task.mode,
				deliverable: options.task.deliverable,
				status: result.status,
				summary: result.summary,
				startedAt,
				finishedAt,
				durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
				model: options.model,
				error: result.error,
			});
		};

		if (options.signal) {
			if (options.signal.aborted) {
				abortHandler();
			} else {
				options.signal.addEventListener("abort", abortHandler, { once: true });
			}
		}

		const processLine = (line: string): void => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let payload: unknown;
			try {
				payload = JSON.parse(trimmed);
			} catch {
				return;
			}
			const type = (payload as { readonly type?: unknown }).type;
			if (type !== "message_end") return;
			const message = (payload as { readonly message?: unknown }).message;
			const assistantText = extractAssistantText(message);
			if (assistantText) {
				latestAssistant = assistantText;
			}
		};

		proc.stdout.on("data", (chunk) => {
			stdoutBuffer += chunk.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				processLine(line);
			}
		});

		proc.stderr.on("data", (chunk) => {
			stderrBuffer += chunk.toString();
		});

		proc.on("close", (code) => {
			if (stdoutBuffer.trim().length > 0) {
				processLine(stdoutBuffer);
			}

			if (aborted) {
				settle({
					status: "error",
					summary: latestAssistant,
					error: "aborted",
				});
				return;
			}

			if ((code ?? 1) !== 0) {
				settle({
					status: "error",
					summary: latestAssistant,
					error: stderrBuffer.trim() || `process exited with code ${code ?? 1}`,
				});
				return;
			}

			settle({
				status: "done",
				summary: latestAssistant,
			});
		});

		proc.on("error", (error) => {
			settle({
				status: "error",
				summary: latestAssistant,
				error: error.message,
			});
		});
	});
}

async function runWithConcurrency<TInput, TResult>(options: {
	readonly items: ReadonlyArray<TInput>;
	readonly concurrency: number;
	readonly worker: (item: TInput, index: number) => Promise<TResult>;
}): Promise<Array<TResult>> {
	if (options.items.length === 0) return [];
	const results: Array<TResult> = new Array<TResult>(options.items.length);
	const concurrency = Math.max(1, Math.min(options.concurrency, options.items.length));
	let cursor = 0;

	const workers = Array.from({ length: concurrency }).map(async () => {
		while (true) {
			const index = cursor;
			cursor += 1;
			if (index >= options.items.length) return;
			results[index] = await options.worker(options.items[index], index);
		}
	});

	await Promise.all(workers);
	return results;
}

function renderFinalSummary(details: ResearchDetails): string {
	const header = `Research fanout complete (${details.completed}/${details.launched})`;
	const modelLine = details.model ? `Model: ${details.model}` : null;
	const synthesis = buildSynthesis(details);
	const sections = details.results.map((result) => {
		const title = `### ${result.label} (${result.role}) [${result.status}]`;
		const metadata = [
			`- goal: ${result.goal}`,
			`- mode: ${result.mode}`,
			`- model: ${result.model ?? "default"}`,
			`- deliverable: ${result.deliverable}`,
			`- duration: ${formatDuration(result.durationMs)}`,
		].join("\n");
		if (result.status === "error") {
			return `${title}\n${metadata}\n\n${result.error ?? "Task failed"}`;
		}
		return `${title}\n${metadata}\n\n${result.summary || "No summary returned"}`;
	});
	return [header, modelLine, synthesis, ...sections].filter((part): part is string => Boolean(part)).join("\n\n");
}

export function registerDesignResearchFanoutTool(pi: ExtensionAPI, binding: ResearchFanoutBinding): void {
	pi.registerTool({
		name: "design_research_fanout",
		label: "Design Research Fanout",
		description:
			"Launches role-based subagent fanout for /start-design-plan phases. Applies /design-plan-config defaults unless call params override them.",
		parameters: RESEARCH_PARAMS,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const topic = params.topic.trim();
			if (!topic) {
				return {
					content: [{ type: "text", text: "Error: topic is required" }],
					isError: true,
				};
			}

			const phase = params.phase as ResearchPhase;
			const config = binding.getConfig();
			const includeInternet =
				params.includeInternet === undefined ? config.researchIncludeInternet : params.includeInternet !== false;
			const maxAgents = Math.max(1, Math.min(4, Math.floor(params.maxAgents ?? config.researchMaxAgents)));
			const selectedModel = params.model?.trim() ? params.model.trim() : config.researchModel;
			const goalList = (params.goals ?? [])
				.map((goal) => goal.trim())
				.filter((goal) => goal.length > 0);
			const customRoles = (params.roles ?? []).filter((role) => role.goal.trim().length > 0);

			const tasks =
				customRoles.length > 0
					? buildCustomRoleTasks(customRoles)
					: goalList.length > 0
						? buildGoalTasks(goalList)
						: buildDefaultTasks({ phase, includeInternet });

			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No research tasks to run" }],
					details: {
						phase,
						topic,
						model: selectedModel,
						launched: 0,
						completed: 0,
						results: [],
					} as ResearchDetails,
				};
			}

			const cwd = params.cwd?.trim() || ctx.cwd;
			const runningResults: Array<ResearchTaskResult> = tasks.map((task) => ({
				id: task.id,
				label: task.label,
				role: task.role,
				goal: task.goal,
				mode: task.mode,
				deliverable: task.deliverable,
				status: "running",
				summary: "",
				startedAt: new Date().toISOString(),
				finishedAt: null,
				durationMs: null,
				model: selectedModel,
			}));

			const emitProgress = (): void => {
				if (!onUpdate) return;
				const completed = runningResults.filter((result) => result.status !== "running").length;
				const details: ResearchDetails = {
					phase,
					topic,
					model: selectedModel,
					launched: runningResults.length,
					completed,
					results: [...runningResults],
				};
				onUpdate({
					content: [{ type: "text", text: buildProgressText(details) }],
					details,
				});
			};

			emitProgress();

			const results = await runWithConcurrency({
				items: tasks,
				concurrency: maxAgents,
				worker: async (task, index) => {
					const result = await runResearchTask({
						phase,
						topic,
						task,
						cwd,
						model: selectedModel,
						signal,
					});
					runningResults[index] = result;
					emitProgress();
					return result;
				},
			});

			const completed = results.filter((result) => result.status !== "running").length;
			const errorCount = results.filter((result) => result.status === "error").length;
			const details: ResearchDetails = {
				phase,
				topic,
				model: selectedModel,
				launched: results.length,
				completed,
				results,
			};

			const summary = renderFinalSummary(details);
			return {
				content: [{ type: "text", text: summary }],
				details,
				isError: errorCount === results.length,
			};
		},
		renderCall(args, theme) {
			const phase = typeof args.phase === "string" ? args.phase : "context";
			const roleCount = Array.isArray(args.roles) ? args.roles.length : 0;
			const goals = Array.isArray(args.goals) ? args.goals.length : 0;
			const selectedModel = typeof args.model === "string" && args.model.trim().length > 0 ? args.model.trim() : null;
			const mode = roleCount > 0 ? `${roleCount} explicit roles` : goals > 0 ? `${goals} custom goals` : "default roles";
			const header =
				theme.fg("toolTitle", theme.bold("design_research_fanout ")) +
				theme.fg("accent", `${phase}`) +
				theme.fg("muted", ` • ${mode}`) +
				(selectedModel ? theme.fg("dim", ` • model ${selectedModel}`) : "");

			const previews: Array<string> = [];
			if (Array.isArray(args.goals)) {
				for (const goal of args.goals.slice(0, 3)) {
					if (typeof goal !== "string") continue;
					const trimmed = goal.trim();
					if (!trimmed) continue;
					previews.push(theme.fg("dim", `- ${goalPreview(trimmed, 76)}`));
				}
			}
			if (previews.length === 0 && Array.isArray(args.roles)) {
				for (const role of args.roles.slice(0, 3)) {
					if (!role || typeof role !== "object") continue;
					const label = typeof role.label === "string" ? role.label.trim() : "role";
					const goal = typeof role.goal === "string" ? role.goal.trim() : "";
					if (!goal) continue;
					previews.push(theme.fg("dim", `- ${label}: ${goalPreview(goal, 68)}`));
				}
			}

			if (previews.length === 0) {
				return new Text(header, 0, 0);
			}
			return new Text(`${header}\n${previews.join("\n")}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ResearchDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const done = details.results.filter((item) => item.status === "done").length;
			const failed = details.results.filter((item) => item.status === "error").length;
			const running = details.results.filter((item) => item.status === "running").length;
			const modelSuffix = details.model ? theme.fg("dim", ` • model ${details.model}`) : "";
			const header =
				theme.fg("success", `✓ ${done}`) +
				theme.fg("muted", ` done`) +
				(failed > 0 ? ` ${theme.fg("warning", `• ${failed} failed`)}` : "") +
				(running > 0 ? ` ${theme.fg("warning", `• ${running} running`)}` : "") +
				theme.fg("dim", ` • phase ${details.phase}`) +
				modelSuffix;

			if (!expanded) {
				const rolePreviewLines = details.results.slice(0, 3).map((item) => {
					const icon = item.status === "done" ? "✓" : item.status === "error" ? "✗" : "⏳";
					return `${icon} ${item.label}: ${goalPreview(item.goal, 52)}`;
				});
				const suffix =
					details.results.length > 3
						? theme.fg("dim", `+${details.results.length - 3} more research tasks`)
						: "";
				const body = rolePreviewLines.length > 0 ? theme.fg("muted", rolePreviewLines.join("\n")) : theme.fg("muted", "(no tasks)");
				return new Text(suffix ? `${header}\n${body}\n${suffix}` : `${header}\n${body}`, 0, 0);
			}

			const lines = [header];
			for (const item of details.results) {
				const icon = item.status === "done" ? "✓" : item.status === "error" ? "✗" : "⏳";
				const detailLine =
					item.status === "error"
						? item.error ?? "failed"
						: item.status === "running"
							? "running"
							: firstSummaryLine(item.summary);
				lines.push(
					`${icon} ${item.label} (${item.role}) • ${item.mode} • ${formatDuration(item.durationMs)} — ${detailLine}\n  goal: ${goalPreview(item.goal, 88)}`,
				);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
