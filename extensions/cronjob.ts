/**
 * Cron Job extension for pi.
 *
 * Usage examples:
 *   /cron add <cron-expression> -- check CI and summarize failures
 *   /cron add --name ci-check <cron-expression> -- check CI and summarize failures
 *   /cron add "<cron-expression>" "check CI and summarize failures"
 *   /cron every 15m -- check CI and summarize failures
 *   /cron every --name ci-check 15m -- check CI and summarize failures
 *   /cron list
 *   /cron remove <job-id-or-name>
 *   /cron pause <job-id-or-name>
 *   /cron resume <job-id-or-name>
 *   /cron run <job-id-or-name>
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

type CronJob = {
	readonly id: string;
	readonly name: string | null;
	readonly schedule: string;
	readonly prompt: string;
	readonly createdAtIso: string;
	readonly enabled: boolean;
	readonly lastRunAtIso: string | null;
};

type PersistedState = {
	readonly version: 1;
	readonly jobs: Array<CronJob>;
};

type ParseResult<TValue> =
	| { readonly success: true; readonly value: TValue }
	| { readonly success: false; readonly error: string };

type FieldMatcher = {
	readonly raw: string;
	readonly min: number;
	readonly max: number;
	readonly allowed: ReadonlySet<number> | null;
};

type ParsedCron = {
	readonly source: string;
	readonly minute: FieldMatcher;
	readonly hour: FieldMatcher;
	readonly dayOfMonth: FieldMatcher;
	readonly month: FieldMatcher;
	readonly dayOfWeek: FieldMatcher;
};

type RuntimeJob = {
	job: CronJob;
	parsed: ParsedCron;
	nextRunAtMs: number | null;
	pendingRuns: number;
};

type DueRuns = {
	readonly dueRuns: number;
	readonly nextRunAtMs: number | null;
};

const STATE_DIRECTORY = path.join(os.homedir(), ".pi", "agent", "extensions", "cronjob");
const STATE_FILE = path.join(STATE_DIRECTORY, "jobs.json");
const TIMER_INTERVAL_MS = 15_000;
const MAX_NEXT_RUN_SEARCH_MINUTES = 366 * 24 * 60;

// -----------------------------
// Functional core (pure logic)
// -----------------------------

function parseCronExpression(schedule: string): ParseResult<ParsedCron> {
	const normalized = schedule.trim().replace(/\s+/g, " ");
	const parts = normalized.split(" ");
	if (parts.length !== 5) {
		return {
			success: false,
			error: "cron expression must have exactly 5 fields: minute hour day-of-month month day-of-week",
		};
	}

	const minute = parseField(parts[0], 0, 59, false);
	if (!minute.success) return minute;

	const hour = parseField(parts[1], 0, 23, false);
	if (!hour.success) return hour;

	const dayOfMonth = parseField(parts[2], 1, 31, false);
	if (!dayOfMonth.success) return dayOfMonth;

	const month = parseField(parts[3], 1, 12, false);
	if (!month.success) return month;

	const dayOfWeek = parseField(parts[4], 0, 7, true);
	if (!dayOfWeek.success) return dayOfWeek;

	return {
		success: true,
		value: {
			source: normalized,
			minute: minute.value,
			hour: hour.value,
			dayOfMonth: dayOfMonth.value,
			month: month.value,
			dayOfWeek: dayOfWeek.value,
		},
	};
}

function parseField(
	rawToken: string,
	min: number,
	max: number,
	convertSevenToZero: boolean,
): ParseResult<FieldMatcher> {
	const token = rawToken.trim();
	if (token.length === 0) {
		return { success: false, error: "cron field cannot be empty" };
	}

	if (token === "*") {
		return {
			success: true,
			value: { raw: token, min, max, allowed: null },
		};
	}

	const values = new Set<number>();
	const parts = token.split(",");
	for (const part of parts) {
		const expanded = expandFieldPart(part.trim(), min, max, convertSevenToZero);
		if (!expanded.success) {
			return expanded;
		}
		for (const value of expanded.value) {
			values.add(value);
		}
	}

	if (values.size === 0) {
		return { success: false, error: `cron field '${token}' produced no values` };
	}

	return {
		success: true,
		value: { raw: token, min, max, allowed: values },
	};
}

function expandFieldPart(
	part: string,
	min: number,
	max: number,
	convertSevenToZero: boolean,
): ParseResult<Array<number>> {
	if (part.length === 0) {
		return { success: false, error: "cron field contains an empty segment" };
	}

	const stepTokens = part.split("/");
	if (stepTokens.length > 2) {
		return { success: false, error: `invalid field segment '${part}'` };
	}
	const [rangePart, stepPart] = stepTokens;
	const step = stepPart === undefined ? 1 : parseInteger(stepPart);
	if (step === null || step <= 0) {
		return { success: false, error: `invalid step '${stepPart}' in cron field` };
	}

	let rangeStart = min;
	let rangeEnd = max;

	if (rangePart !== "*") {
		if (rangePart.includes("-")) {
			const [startText, endText] = rangePart.split("-");
			const start = parseInteger(startText);
			const end = parseInteger(endText);
			if (start === null || end === null) {
				return { success: false, error: `invalid range '${rangePart}' in cron field` };
			}
			if (start > end) {
				return { success: false, error: `range start must be <= range end in '${rangePart}'` };
			}
			rangeStart = start;
			rangeEnd = end;
		} else {
			const singleValue = parseInteger(rangePart);
			if (singleValue === null) {
				return { success: false, error: `invalid value '${rangePart}' in cron field` };
			}
			rangeStart = singleValue;
			rangeEnd = singleValue;
		}
	}

	if (rangeStart < min || rangeEnd > max) {
		return {
			success: false,
			error: `value out of range in cron field '${part}' (allowed ${min}-${max})`,
		};
	}

	const result: Array<number> = [];
	for (let value = rangeStart; value <= rangeEnd; value += step) {
		if (convertSevenToZero && value === 7) {
			result.push(0);
		} else {
			result.push(value);
		}
	}

	return { success: true, value: result };
}

function parseInteger(rawValue: string): number | null {
	if (!/^\d+$/.test(rawValue)) {
		return null;
	}
	const parsed = Number.parseInt(rawValue, 10);
	if (!Number.isFinite(parsed)) {
		return null;
	}
	return parsed;
}

function fieldMatches(matcher: FieldMatcher, value: number): boolean {
	if (matcher.allowed === null) {
		return true;
	}
	return matcher.allowed.has(value);
}

function cronMatches(parsed: ParsedCron, date: Date): boolean {
	const minuteMatches = fieldMatches(parsed.minute, date.getMinutes());
	const hourMatches = fieldMatches(parsed.hour, date.getHours());
	const monthMatches = fieldMatches(parsed.month, date.getMonth() + 1);

	const dayOfMonthMatches = fieldMatches(parsed.dayOfMonth, date.getDate());
	const dayOfWeekMatches = fieldMatches(parsed.dayOfWeek, date.getDay());
	const dayOfMonthIsAny = parsed.dayOfMonth.allowed === null;
	const dayOfWeekIsAny = parsed.dayOfWeek.allowed === null;

	let dayMatches = false;
	if (dayOfMonthIsAny && dayOfWeekIsAny) {
		dayMatches = true;
	} else if (dayOfMonthIsAny) {
		dayMatches = dayOfWeekMatches;
	} else if (dayOfWeekIsAny) {
		dayMatches = dayOfMonthMatches;
	} else {
		// Standard cron behavior: when both fields are restricted, either may match.
		dayMatches = dayOfMonthMatches || dayOfWeekMatches;
	}

	return minuteMatches && hourMatches && monthMatches && dayMatches;
}

function nextRunAfter(parsed: ParsedCron, afterMs: number): number | null {
	const candidate = new Date(afterMs);
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	for (let index = 0; index < MAX_NEXT_RUN_SEARCH_MINUTES; index += 1) {
		if (cronMatches(parsed, candidate)) {
			return candidate.getTime();
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}

	return null;
}

function collectDueRuns(parsed: ParsedCron, nextRunAtMs: number | null, nowMs: number): DueRuns {
	let cursor = nextRunAtMs;
	let dueRuns = 0;
	while (cursor !== null && cursor <= nowMs) {
		dueRuns += 1;
		cursor = nextRunAfter(parsed, cursor);
	}
	return { dueRuns, nextRunAtMs: cursor };
}

function parseEveryToSchedule(everyRaw: string): ParseResult<string> {
	const every = everyRaw.trim().toLowerCase();
	const matched = every.match(/^(\d+)(m|h|d)$/);
	if (matched === null) {
		return {
			success: false,
			error: "invalid interval. use forms like 15m, 2h, or 1d",
		};
	}

	const value = parseInteger(matched[1]);
	if (value === null || value === 0) {
		return { success: false, error: "interval value must be greater than zero" };
	}

	const unit = matched[2];
	if (unit === "m") {
		if (value > 59) {
			return { success: false, error: "minute interval must be between 1 and 59" };
		}
		return { success: true, value: `*/${value} * * * *` };
	}
	if (unit === "h") {
		if (value > 23) {
			return { success: false, error: "hour interval must be between 1 and 23" };
		}
		return { success: true, value: `0 */${value} * * *` };
	}
	if (value > 31) {
		return { success: false, error: "day interval must be between 1 and 31" };
	}
	return { success: true, value: `0 0 */${value} * *` };
}

function formatTimestamp(timestampMs: number | null): string {
	if (timestampMs === null) {
		return "(none)";
	}
	return new Date(timestampMs).toLocaleString();
}

function normalizeName(name: string): string {
	return name.trim().toLowerCase();
}

function formatJobIdentity(job: CronJob): string {
	if (job.name === null) {
		return job.id;
	}
	return `${job.name} (${job.id})`;
}

function formatJobForList(runtimeJob: RuntimeJob): string {
	const lastRunMs = runtimeJob.job.lastRunAtIso === null ? null : Date.parse(runtimeJob.job.lastRunAtIso);
	const nextRunText = formatTimestamp(runtimeJob.nextRunAtMs);
	const lastRunText = formatTimestamp(Number.isNaN(lastRunMs ?? Number.NaN) ? null : lastRunMs);
	const status = runtimeJob.job.enabled ? "enabled" : "paused";
	const promptPreview = runtimeJob.job.prompt.length > 80
		? `${runtimeJob.job.prompt.slice(0, 77)}...`
		: runtimeJob.job.prompt;
	return `${formatJobIdentity(runtimeJob.job)}  ${status}\n  schedule: ${runtimeJob.job.schedule}\n  next: ${nextRunText}\n  last: ${lastRunText}\n  queued: ${runtimeJob.pendingRuns}\n  prompt: ${promptPreview}`;
}

function parseAddArguments(raw: string): ParseResult<{ readonly schedule: string; readonly prompt: string }> {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return { success: false, error: "missing arguments. expected a cron expression and a prompt" };
	}

	const quotedMatch = trimmed.match(/^"([^"]+)"\s+"([\s\S]+)"$/);
	if (quotedMatch !== null) {
		return {
			success: true,
			value: {
				schedule: quotedMatch[1].trim(),
				prompt: quotedMatch[2].trim(),
			},
		};
	}

	const separator = " -- ";
	const separatorIndex = trimmed.indexOf(separator);
	if (separatorIndex >= 0) {
		const schedule = trimmed.slice(0, separatorIndex).trim();
		const prompt = trimmed.slice(separatorIndex + separator.length).trim();
		if (schedule.length === 0 || prompt.length === 0) {
			return { success: false, error: "both schedule and prompt are required" };
		}
		return { success: true, value: { schedule, prompt } };
	}

	const fallbackMatch = trimmed.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+([\s\S]+)$/);
	if (fallbackMatch !== null) {
		return {
			success: true,
			value: {
				schedule: fallbackMatch[1].trim(),
				prompt: fallbackMatch[2].trim(),
			},
		};
	}

	return {
		success: false,
		error: "could not parse arguments. use: /cron add <cron> -- <prompt>",
	};
}

function parseOptionalNamePrefix(raw: string): ParseResult<{ readonly name: string | null; readonly remainder: string }> {
	const trimmed = raw.trim();
	if (!trimmed.startsWith("--name")) {
		return { success: true, value: { name: null, remainder: trimmed } };
	}

	const matched = trimmed.match(/^--name\s+(?:"([^"]+)"|(\S+))(?:\s+([\s\S]+))?$/);
	if (matched === null) {
		return {
			success: false,
			error: "invalid --name usage. use --name <name> before the schedule/interval",
		};
	}

	const rawName = (matched[1] ?? matched[2] ?? "").trim();
	if (rawName.length === 0) {
		return { success: false, error: "job name cannot be empty" };
	}

	const remainder = (matched[3] ?? "").trim();
	if (remainder.length === 0) {
		return { success: false, error: "missing schedule/interval after --name" };
	}

	return { success: true, value: { name: rawName, remainder } };
}

// ---------------------------------
// Imperative shell (I/O + orchestration)
// ---------------------------------

function ensureStateDirectory(): void {
	fs.mkdirSync(STATE_DIRECTORY, { recursive: true });
}

function loadState(): ParseResult<PersistedState> {
	try {
		if (!fs.existsSync(STATE_FILE)) {
			return { success: true, value: { version: 1, jobs: [] } };
		}

		const rawText = fs.readFileSync(STATE_FILE, "utf8");
		const parsed: unknown = JSON.parse(rawText);
		const validated = validatePersistedState(parsed);
		if (!validated.success) {
			return validated;
		}
		return { success: true, value: validated.value };
	} catch (error) {
		return {
			success: false,
			error: `failed to load cron jobs: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function validatePersistedState(raw: unknown): ParseResult<PersistedState> {
	if (typeof raw !== "object" || raw === null) {
		return { success: false, error: "invalid cron state: expected object" };
	}

	const maybeState = raw as { version?: unknown; jobs?: unknown };
	if (maybeState.version !== 1) {
		return { success: false, error: "invalid cron state: unsupported version" };
	}
	if (!Array.isArray(maybeState.jobs)) {
		return { success: false, error: "invalid cron state: jobs must be an array" };
	}

	const jobs: Array<CronJob> = [];
	for (const rawJob of maybeState.jobs) {
		const validatedJob = validateCronJob(rawJob);
		if (!validatedJob.success) {
			return validatedJob;
		}
		jobs.push(validatedJob.value);
	}

	return { success: true, value: { version: 1, jobs } };
}

function validateCronJob(raw: unknown): ParseResult<CronJob> {
	if (typeof raw !== "object" || raw === null) {
		return { success: false, error: "invalid cron job entry" };
	}

	const candidate = raw as {
		id?: unknown;
		name?: unknown;
		schedule?: unknown;
		prompt?: unknown;
		createdAtIso?: unknown;
		enabled?: unknown;
		lastRunAtIso?: unknown;
	};

	if (typeof candidate.id !== "string" || candidate.id.trim().length === 0) {
		return { success: false, error: "invalid cron job id" };
	}
	if (candidate.name !== undefined && candidate.name !== null && typeof candidate.name !== "string") {
		return { success: false, error: `invalid cron name for job ${candidate.id}` };
	}
	if (typeof candidate.name === "string" && candidate.name.trim().length === 0) {
		return { success: false, error: `invalid cron name for job ${candidate.id}` };
	}
	if (typeof candidate.schedule !== "string" || candidate.schedule.trim().length === 0) {
		return { success: false, error: `invalid cron schedule for job ${candidate.id}` };
	}
	if (typeof candidate.prompt !== "string" || candidate.prompt.trim().length === 0) {
		return { success: false, error: `invalid cron prompt for job ${candidate.id}` };
	}
	if (typeof candidate.createdAtIso !== "string" || Number.isNaN(Date.parse(candidate.createdAtIso))) {
		return { success: false, error: `invalid createdAtIso for job ${candidate.id}` };
	}
	if (typeof candidate.enabled !== "boolean") {
		return { success: false, error: `invalid enabled flag for job ${candidate.id}` };
	}
	if (candidate.lastRunAtIso !== null && typeof candidate.lastRunAtIso !== "string") {
		return { success: false, error: `invalid lastRunAtIso for job ${candidate.id}` };
	}
	if (typeof candidate.lastRunAtIso === "string" && Number.isNaN(Date.parse(candidate.lastRunAtIso))) {
		return { success: false, error: `invalid lastRunAtIso timestamp for job ${candidate.id}` };
	}

	return {
		success: true,
		value: {
			id: candidate.id,
			name: typeof candidate.name === "string" ? candidate.name.trim() : null,
			schedule: candidate.schedule.trim().replace(/\s+/g, " "),
			prompt: candidate.prompt.trim(),
			createdAtIso: candidate.createdAtIso,
			enabled: candidate.enabled,
			lastRunAtIso: candidate.lastRunAtIso,
		},
	};
}

function saveState(runtimeJobsById: ReadonlyMap<string, RuntimeJob>): ParseResult<null> {
	try {
		ensureStateDirectory();
		const jobs = Array.from(runtimeJobsById.values()).map((runtimeJob) => runtimeJob.job);
		const state: PersistedState = { version: 1, jobs };
		const temporaryFile = `${STATE_FILE}.tmp`;
		fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), "utf8");
		fs.renameSync(temporaryFile, STATE_FILE);
		return { success: true, value: null };
	} catch (error) {
		return {
			success: false,
			error: `failed to save cron jobs: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

function buildRuntimeJob(job: CronJob, nowMs: number): ParseResult<RuntimeJob> {
	const parsed = parseCronExpression(job.schedule);
	if (!parsed.success) {
		return { success: false, error: `job ${job.id}: ${parsed.error}` };
	}

	return {
		success: true,
		value: {
			job,
			parsed: parsed.value,
			nextRunAtMs: nextRunAfter(parsed.value, nowMs),
			pendingRuns: 0,
		},
	};
}

function buildPrompt(job: CronJob): string {
	const label = job.name === null ? job.id : `${job.name} (${job.id})`;
	return `[scheduled task ${label} | ${job.schedule}]\n${job.prompt}`;
}

export default function cronJobExtension(pi: ExtensionAPI): void {
	let runtimeJobsById = new Map<string, RuntimeJob>();
	let timer: ReturnType<typeof setInterval> | null = null;
	let isAgentBusy = false;
	let notify: ((message: string, level: NotifyLevel) => void) | null = null;

	const sendNotification = (message: string, level: NotifyLevel = "info") => {
		if (notify !== null) {
			notify(message, level);
		}
	};

	const persistState = () => {
		const persisted = saveState(runtimeJobsById);
		if (!persisted.success) {
			sendNotification(persisted.error, "error");
		}
	};

	const triggerJob = (runtimeJob: RuntimeJob) => {
		const message = buildPrompt(runtimeJob.job);
		pi.sendUserMessage(message);

		runtimeJob.job = {
			...runtimeJob.job,
			lastRunAtIso: new Date().toISOString(),
		};
		runtimeJobsById.set(runtimeJob.job.id, runtimeJob);
		persistState();
	};

	const dispatchOnePendingRun = (runtimeJob: RuntimeJob, source: "scheduled" | "manual") => {
		if (runtimeJob.pendingRuns <= 0) {
			return;
		}

		runtimeJob.pendingRuns -= 1;
		runtimeJobsById.set(runtimeJob.job.id, runtimeJob);

		try {
			// Set proactively so one tick cannot dispatch multiple jobs before agent_start arrives.
			isAgentBusy = true;
			triggerJob(runtimeJob);
			const suffix = runtimeJob.pendingRuns > 0 ? ` (${runtimeJob.pendingRuns} queued)` : "";
			sendNotification(`ran cron job ${formatJobIdentity(runtimeJob.job)}${suffix}`, "info");
		} catch (error) {
			isAgentBusy = false;
			runtimeJob.pendingRuns += 1;
			runtimeJobsById.set(runtimeJob.job.id, runtimeJob);
			sendNotification(
				`failed to run cron job ${formatJobIdentity(runtimeJob.job)} (${source}): ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	};

	const tick = () => {
		const nowMs = Date.now();
		for (const runtimeJob of runtimeJobsById.values()) {
			if (!runtimeJob.job.enabled) {
				continue;
			}

			const due = collectDueRuns(runtimeJob.parsed, runtimeJob.nextRunAtMs, nowMs);
			if (due.dueRuns <= 0) {
				continue;
			}

			runtimeJob.nextRunAtMs = due.nextRunAtMs;
			runtimeJob.pendingRuns += due.dueRuns;
			runtimeJobsById.set(runtimeJob.job.id, runtimeJob);

			if (isAgentBusy) {
				sendNotification(
					`queued ${due.dueRuns} run(s) for cron job ${formatJobIdentity(runtimeJob.job)} (pending: ${runtimeJob.pendingRuns})`,
					"warning",
				);
			}
		}

		if (isAgentBusy) {
			return;
		}

		for (const runtimeJob of runtimeJobsById.values()) {
			if (!runtimeJob.job.enabled || runtimeJob.pendingRuns <= 0) {
				continue;
			}
			dispatchOnePendingRun(runtimeJob, "scheduled");
			break;
		}
	};

	const loadJobsIntoMemory = () => {
		const loaded = loadState();
		if (!loaded.success) {
			sendNotification(loaded.error, "error");
			return;
		}

		const nowMs = Date.now();
		const nextMap = new Map<string, RuntimeJob>();
		const seenNames = new Set<string>();
		for (const job of loaded.value.jobs) {
			const runtime = buildRuntimeJob(job, nowMs);
			if (!runtime.success) {
				sendNotification(runtime.error, "warning");
				continue;
			}
			if (runtime.value.job.name !== null) {
				const normalizedName = normalizeName(runtime.value.job.name);
				if (seenNames.has(normalizedName)) {
					sendNotification(`duplicate cron job name '${runtime.value.job.name}' detected. skipping job ${runtime.value.job.id}`, "warning");
					continue;
				}
				seenNames.add(normalizedName);
			}
			nextMap.set(job.id, runtime.value);
		}
		runtimeJobsById = nextMap;
	};

	const upsertJob = (job: CronJob): ParseResult<RuntimeJob> => {
		if (job.name !== null) {
			const normalizedName = normalizeName(job.name);
			for (const existing of runtimeJobsById.values()) {
				if (existing.job.id === job.id || existing.job.name === null) {
					continue;
				}
				if (normalizeName(existing.job.name) === normalizedName) {
					return { success: false, error: `job name already exists: ${job.name}` };
				}
			}
		}

		const runtime = buildRuntimeJob(job, Date.now());
		if (!runtime.success) {
			return runtime;
		}
		runtimeJobsById.set(job.id, runtime.value);
		persistState();
		return runtime;
	};

	const hasJobName = (name: string): boolean => {
		const normalizedName = normalizeName(name);
		for (const runtimeJob of runtimeJobsById.values()) {
			if (runtimeJob.job.name !== null && normalizeName(runtimeJob.job.name) === normalizedName) {
				return true;
			}
		}
		return false;
	};

	const getJobByIdentifier = (identifierRaw: string): ParseResult<RuntimeJob> => {
		const identifier = identifierRaw.trim();
		if (identifier.length === 0) {
			return { success: false, error: "job identifier cannot be empty" };
		}

		const byId = runtimeJobsById.get(identifier);
		if (byId !== undefined) {
			return { success: true, value: byId };
		}

		const normalizedName = normalizeName(identifier);
		const byName: Array<RuntimeJob> = [];
		for (const runtimeJob of runtimeJobsById.values()) {
			if (runtimeJob.job.name !== null && normalizeName(runtimeJob.job.name) === normalizedName) {
				byName.push(runtimeJob);
			}
		}

		if (byName.length === 1) {
			return { success: true, value: byName[0] };
		}
		if (byName.length > 1) {
			return { success: false, error: `ambiguous job name '${identifier}'` };
		}
		return { success: false, error: `job not found: ${identifier}` };
	};

	const printHelp = (emit: (message: string, level: NotifyLevel) => void): void => {
		emit(
			"cron commands: add, every, list, remove, pause, resume, run\n" +
				"selectors: remove/pause/resume/run accept id or name\n" +
				"busy behavior: due runs are queued and drained when idle\n" +
				"examples:\n" +
				"/cron add */15 * * * * -- check CI\n" +
				"/cron add --name ci-check */15 * * * * -- check CI\n" +
				"/cron add \"*/15 * * * *\" \"check CI\"\n" +
				"/cron every --name ci-check 15m -- check CI",
			"info",
		);
	};

	pi.on("session_start", async (_event, ctx) => {
		notify = ctx.hasUI ? (message, level) => ctx.ui.notify(message, level) : null;
		loadJobsIntoMemory();

		if (timer !== null) {
			clearInterval(timer);
		}
		timer = setInterval(tick, TIMER_INTERVAL_MS);
		tick();

		if (ctx.hasUI) {
			ctx.ui.notify(`cronjob extension loaded (${runtimeJobsById.size} jobs)`, "info");
		}
	});

	pi.on("agent_start", async () => {
		isAgentBusy = true;
	});

	pi.on("agent_end", async () => {
		isAgentBusy = false;
	});

	pi.on("session_shutdown", async () => {
		if (timer !== null) {
			clearInterval(timer);
			timer = null;
		}
		notify = null;
	});

	pi.registerCommand("cron", {
		description: "Manage scheduled prompts (cron jobs)",
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (args.length === 0 || args === "help") {
				printHelp((message, level) => ctx.ui.notify(message, level));
				return;
			}

			if (args === "list") {
				if (runtimeJobsById.size === 0) {
					ctx.ui.notify("no cron jobs configured", "info");
					return;
				}

				const lines = Array.from(runtimeJobsById.values())
					.sort((left, right) => formatJobIdentity(left.job).localeCompare(formatJobIdentity(right.job)))
					.map(formatJobForList)
					.join("\n\n");
				ctx.ui.notify(lines, "info");
				return;
			}

			if (args.startsWith("add ")) {
				const nameParse = parseOptionalNamePrefix(args.slice(4));
				if (!nameParse.success) {
					ctx.ui.notify(nameParse.error, "error");
					return;
				}
				if (nameParse.value.name !== null && hasJobName(nameParse.value.name)) {
					ctx.ui.notify(`job name already exists: ${nameParse.value.name}`, "error");
					return;
				}

				const parsed = parseAddArguments(nameParse.value.remainder);
				if (!parsed.success) {
					ctx.ui.notify(parsed.error, "error");
					return;
				}

				const parsedCron = parseCronExpression(parsed.value.schedule);
				if (!parsedCron.success) {
					ctx.ui.notify(parsedCron.error, "error");
					return;
				}

				const id = randomUUID().slice(0, 8);
				const job: CronJob = {
					id,
					name: nameParse.value.name,
					schedule: parsedCron.value.source,
					prompt: parsed.value.prompt,
					createdAtIso: new Date().toISOString(),
					enabled: true,
					lastRunAtIso: null,
				};

				const result = upsertJob(job);
				if (!result.success) {
					ctx.ui.notify(result.error, "error");
					return;
				}

				ctx.ui.notify(
					`added cron job ${formatJobIdentity(job)}, next run: ${formatTimestamp(result.value.nextRunAtMs)}`,
					"info",
				);
				return;
			}

			if (args.startsWith("every ")) {
				const nameParse = parseOptionalNamePrefix(args.slice(6));
				if (!nameParse.success) {
					ctx.ui.notify(nameParse.error, "error");
					return;
				}
				if (nameParse.value.name !== null && hasJobName(nameParse.value.name)) {
					ctx.ui.notify(`job name already exists: ${nameParse.value.name}`, "error");
					return;
				}

				const payload = nameParse.value.remainder;
				const separator = " -- ";
				const separatorIndex = payload.indexOf(separator);
				if (separatorIndex < 0) {
					ctx.ui.notify("usage: /cron every [--name <name>] <interval> -- <prompt>", "error");
					return;
				}

				const intervalText = payload.slice(0, separatorIndex).trim();
				const prompt = payload.slice(separatorIndex + separator.length).trim();
				if (prompt.length === 0) {
					ctx.ui.notify("prompt cannot be empty", "error");
					return;
				}

				const schedule = parseEveryToSchedule(intervalText);
				if (!schedule.success) {
					ctx.ui.notify(schedule.error, "error");
					return;
				}

				const id = randomUUID().slice(0, 8);
				const job: CronJob = {
					id,
					name: nameParse.value.name,
					schedule: schedule.value,
					prompt,
					createdAtIso: new Date().toISOString(),
					enabled: true,
					lastRunAtIso: null,
				};

				const result = upsertJob(job);
				if (!result.success) {
					ctx.ui.notify(result.error, "error");
					return;
				}

				ctx.ui.notify(
					`added cron job ${formatJobIdentity(job)} (${schedule.value}), next run: ${formatTimestamp(result.value.nextRunAtMs)}`,
					"info",
				);
				return;
			}

			if (args.startsWith("remove ")) {
				const identifier = args.slice(7).trim();
				if (identifier.length === 0) {
					ctx.ui.notify("usage: /cron remove <job-id-or-name>", "error");
					return;
				}
				const resolved = getJobByIdentifier(identifier);
				if (!resolved.success) {
					ctx.ui.notify(resolved.error, "error");
					return;
				}

				runtimeJobsById.delete(resolved.value.job.id);
				persistState();
				ctx.ui.notify(`removed cron job ${formatJobIdentity(resolved.value.job)}`, "info");
				return;
			}

			if (args.startsWith("pause ")) {
				const identifier = args.slice(6).trim();
				if (identifier.length === 0) {
					ctx.ui.notify("usage: /cron pause <job-id-or-name>", "error");
					return;
				}
				const resolved = getJobByIdentifier(identifier);
				if (!resolved.success) {
					ctx.ui.notify(resolved.error, "error");
					return;
				}
				const runtimeJob = resolved.value;
				const droppedRuns = runtimeJob.pendingRuns;
				runtimeJob.job = { ...runtimeJob.job, enabled: false };
				runtimeJob.pendingRuns = 0;
				runtimeJobsById.set(runtimeJob.job.id, runtimeJob);
				persistState();
				const suffix = droppedRuns > 0 ? ` (cleared ${droppedRuns} queued run(s))` : "";
				ctx.ui.notify(`paused cron job ${formatJobIdentity(runtimeJob.job)}${suffix}`, "info");
				return;
			}

			if (args.startsWith("resume ")) {
				const identifier = args.slice(7).trim();
				if (identifier.length === 0) {
					ctx.ui.notify("usage: /cron resume <job-id-or-name>", "error");
					return;
				}
				const resolved = getJobByIdentifier(identifier);
				if (!resolved.success) {
					ctx.ui.notify(resolved.error, "error");
					return;
				}
				const runtimeJob = resolved.value;
				runtimeJob.job = { ...runtimeJob.job, enabled: true };
				runtimeJob.nextRunAtMs = nextRunAfter(runtimeJob.parsed, Date.now());
				runtimeJobsById.set(runtimeJob.job.id, runtimeJob);
				persistState();
				ctx.ui.notify(`resumed cron job ${formatJobIdentity(runtimeJob.job)}`, "info");
				return;
			}

			if (args.startsWith("run ")) {
				const identifier = args.slice(4).trim();
				if (identifier.length === 0) {
					ctx.ui.notify("usage: /cron run <job-id-or-name>", "error");
					return;
				}
				const resolved = getJobByIdentifier(identifier);
				if (!resolved.success) {
					ctx.ui.notify(resolved.error, "error");
					return;
				}
				const runtimeJob = resolved.value;

				runtimeJob.pendingRuns += 1;
				runtimeJobsById.set(runtimeJob.job.id, runtimeJob);

				if (isAgentBusy) {
					ctx.ui.notify(
						`queued manual run for cron job ${formatJobIdentity(runtimeJob.job)} (pending: ${runtimeJob.pendingRuns})`,
						"info",
					);
					return;
				}

				dispatchOnePendingRun(runtimeJob, "manual");
				return;
			}

			ctx.ui.notify("unknown subcommand. try /cron help", "error");
		},
	});
}
