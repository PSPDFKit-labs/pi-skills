import { spawn } from "node:child_process";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

type ResearchPhase = "context" | "brainstorm";

type ResearchMode = "codebase" | "internet" | "hybrid";

type ResearchTask = {
	readonly label: string;
	readonly goal: string;
	readonly mode: ResearchMode;
};

type ResearchTaskResult = {
	readonly label: string;
	readonly goal: string;
	readonly mode: ResearchMode;
	readonly status: "running" | "done" | "error";
	readonly summary: string;
	readonly error?: string;
};

type ResearchDetails = {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly launched: number;
	readonly completed: number;
	readonly results: ReadonlyArray<ResearchTaskResult>;
};

const PHASE_SCHEMA = StringEnum(["context", "brainstorm"] as const, {
	description: "Research phase",
});

const RESEARCH_PARAMS = Type.Object({
	phase: PHASE_SCHEMA,
	topic: Type.String({ description: "Design topic under investigation" }),
	goals: Type.Optional(Type.Array(Type.String({ description: "Specific research goal" }))),
	includeInternet: Type.Optional(
		Type.Boolean({
			description: "Include internet-oriented research tasks (default: true)",
			default: true,
		}),
	),
	maxAgents: Type.Optional(
		Type.Number({
			description: "Maximum concurrent research agents (1-4, default 3)",
			minimum: 1,
			maximum: 4,
			default: 3,
		}),
	),
	cwd: Type.Optional(Type.String({ description: "Working directory override for research subprocesses" })),
});

function buildDefaultTasks(options: {
	readonly phase: ResearchPhase;
	readonly includeInternet: boolean;
}): ReadonlyArray<ResearchTask> {
	if (options.phase === "context") {
		const tasks: Array<ResearchTask> = [
			{
				label: "codebase-investigator",
				goal: "Identify existing code paths, files, and patterns directly relevant to the design topic.",
				mode: "codebase",
			},
			{
				label: "architecture-investigator",
				goal: "Identify architectural constraints, dependencies, and integration boundaries in the current codebase.",
				mode: "hybrid",
			},
		];
		if (options.includeInternet) {
			tasks.push({
				label: "internet-researcher",
				goal: "Identify current external best practices, standards, and known pitfalls relevant to this topic.",
				mode: "internet",
			});
		}
		return tasks;
	}

	const tasks: Array<ResearchTask> = [
		{
			label: "critical-path-investigator",
			goal: "Identify bottlenecks, critical path hotspots, and performance-sensitive boundaries for this topic.",
			mode: "codebase",
		},
		{
			label: "tradeoff-investigator",
			goal: "Identify viable implementation alternatives and concrete trade-offs grounded in this codebase.",
			mode: "hybrid",
		},
	];
	if (options.includeInternet) {
		tasks.push({
			label: "industry-researcher",
			goal: "Identify external benchmark patterns and reference designs relevant to this problem.",
			mode: "internet",
		});
	}
	return tasks;
}

function buildCustomTasks(goals: ReadonlyArray<string>): ReadonlyArray<ResearchTask> {
	return goals.map((goal, index) => ({
		label: `research-${index + 1}`,
		goal,
		mode: "hybrid",
	}));
}

function buildResearchPrompt(options: {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly task: ResearchTask;
}): string {
	const modeHint =
		options.task.mode === "codebase"
			? "Prioritize codebase inspection (paths, symbols, dependencies)."
			: options.task.mode === "internet"
				? "Prioritize external standards and best-practice references. If internet tools are unavailable, explicitly say so."
				: "Use both codebase and external knowledge where possible.";

	return [
		`You are ${options.task.label}.`,
		`Phase: ${options.phase}`,
		`Topic: ${options.topic}`,
		`Goal: ${options.task.goal}`,
		"",
		modeHint,
		"",
		"Output format:",
		"## Findings",
		"- concise bullets",
		"",
		"## Evidence",
		"- include concrete file paths / symbols / references where possible",
		"",
		"## Risks & Unknowns",
		"- unresolved assumptions or data gaps",
		"",
		"## Recommendation",
		"- what this means for the design plan",
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

function buildProgressText(details: ResearchDetails): string {
	const lines: Array<string> = [
		`Research fanout (${details.phase}) ${details.completed}/${details.launched} complete`,
	];
	for (const result of details.results) {
		const statusIcon = result.status === "done" ? "✓" : result.status === "error" ? "✗" : "⏳";
		const suffix = result.status === "error" ? ` — ${result.error ?? "failed"}` : "";
		lines.push(`${statusIcon} ${result.label}${suffix}`);
	}
	return lines.join("\n");
}

async function runResearchTask(options: {
	readonly phase: ResearchPhase;
	readonly topic: string;
	readonly task: ResearchTask;
	readonly cwd: string;
	readonly signal?: AbortSignal;
}): Promise<ResearchTaskResult> {
	const prompt = buildResearchPrompt({
		phase: options.phase,
		topic: options.topic,
		task: options.task,
	});

	return await new Promise<ResearchTaskResult>((resolve) => {
		const args = ["--mode", "json", "-p", "--no-session", prompt];
		const proc = spawn("pi", args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";
		let latestAssistant = "";
		let aborted = false;

		const killProcess = (): void => {
			aborted = true;
			proc.kill("SIGTERM");
			setTimeout(() => {
				if (!proc.killed) {
					proc.kill("SIGKILL");
				}
			}, 2000);
		};

		if (options.signal) {
			if (options.signal.aborted) {
				killProcess();
			} else {
				options.signal.addEventListener("abort", killProcess, { once: true });
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
				resolve({
					label: options.task.label,
					goal: options.task.goal,
					mode: options.task.mode,
					status: "error",
					summary: "",
					error: "aborted",
				});
				return;
			}

			if ((code ?? 1) !== 0) {
				resolve({
					label: options.task.label,
					goal: options.task.goal,
					mode: options.task.mode,
					status: "error",
					summary: latestAssistant,
					error: stderrBuffer.trim() || `process exited with code ${code ?? 1}`,
				});
				return;
			}

			resolve({
				label: options.task.label,
				goal: options.task.goal,
				mode: options.task.mode,
				status: "done",
				summary: latestAssistant,
			});
		});

		proc.on("error", (error) => {
			resolve({
				label: options.task.label,
				goal: options.task.goal,
				mode: options.task.mode,
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
	const sections = details.results.map((result) => {
		const title = `### ${result.label} [${result.status}]`;
		if (result.status === "error") {
			return `${title}\n${result.error ?? "Task failed"}`;
		}
		return `${title}\n${result.summary || "No summary returned"}`;
	});
	return [header, ...sections].join("\n\n");
}

export function registerDesignResearchFanoutTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "design_research_fanout",
		label: "Design Research Fanout",
		description:
			"Launches parallel research agents for /start-design-plan phases and returns synthesized findings for clarification/brainstorming.",
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
			const includeInternet = params.includeInternet !== false;
			const maxAgents = Math.max(1, Math.min(4, Math.floor(params.maxAgents ?? 3)));
			const goalList = (params.goals ?? [])
				.map((goal) => goal.trim())
				.filter((goal) => goal.length > 0);

			const tasks =
				goalList.length > 0 ? buildCustomTasks(goalList) : buildDefaultTasks({ phase, includeInternet });
			if (tasks.length === 0) {
				return {
					content: [{ type: "text", text: "No research tasks to run" }],
					details: {
						phase,
						topic,
						launched: 0,
						completed: 0,
						results: [],
					} as ResearchDetails,
				};
			}

			const cwd = params.cwd?.trim() || ctx.cwd;
			const runningResults: Array<ResearchTaskResult> = tasks.map((task) => ({
				label: task.label,
				goal: task.goal,
				mode: task.mode,
				status: "running",
				summary: "",
			}));

			const emitProgress = (): void => {
				if (!onUpdate) return;
				const completed = runningResults.filter((result) => result.status !== "running").length;
				const details: ResearchDetails = {
					phase,
					topic,
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
			const goals = Array.isArray(args.goals) ? args.goals.length : 0;
			const text =
				theme.fg("toolTitle", theme.bold("design_research_fanout ")) +
				theme.fg("accent", `${phase}`) +
				theme.fg("muted", ` • ${goals > 0 ? `${goals} custom goals` : "default goals"}`);
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as ResearchDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			const done = details.results.filter((item) => item.status === "done").length;
			const failed = details.results.filter((item) => item.status === "error").length;
			const header =
				theme.fg("success", `✓ ${done}`) +
				theme.fg("muted", ` done`) +
				(failed > 0 ? ` ${theme.fg("warning", `• ${failed} failed`)}` : "") +
				theme.fg("dim", ` • phase ${details.phase}`);

			if (!expanded) {
				return new Text(header, 0, 0);
			}

			const lines = [header];
			for (const item of details.results) {
				const icon = item.status === "done" ? "✓" : item.status === "error" ? "✗" : "⏳";
				const detailLine = item.status === "error" ? item.error ?? "failed" : "ok";
				lines.push(`${icon} ${item.label} — ${detailLine}`);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
