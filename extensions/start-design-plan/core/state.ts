import type {
	AnyDesignTrackerState,
	DesignPhase,
	DesignTask,
	DesignTrackerState,
	PhaseDefinition,
	PhaseStatus,
	TaskStatus,
	TrackerMutationResult,
} from "./types";

export const TRACKER_ENTRY_TYPE = "start-design-plan-tracker-state";

export const DEFAULT_PHASES: ReadonlyArray<PhaseDefinition> = [
	{ id: "phase-1", order: 1, title: "Context Gathering" },
	{ id: "phase-2", order: 2, title: "Clarification" },
	{ id: "phase-3", order: 3, title: "Definition of Done" },
	{ id: "phase-4", order: 4, title: "Brainstorming" },
	{ id: "phase-5", order: 5, title: "Design Documentation" },
] as const;

export type TrackerEntryData = {
	readonly state: DesignTrackerState | null;
};

function findPhaseIndex(phases: ReadonlyArray<DesignPhase>, phaseId: string): number {
	return phases.findIndex((phase) => phase.id === phaseId);
}

function findTaskIndex(tasks: ReadonlyArray<DesignTask>, taskId: string): number {
	return tasks.findIndex((task) => task.id === taskId);
}

function normalizeTopic(topic: string): string {
	return topic.trim();
}

function normalizeIso(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : fallback;
}

function buildInitialPhases(nowIso: string): ReadonlyArray<DesignPhase> {
	return DEFAULT_PHASES.map((definition) => ({
		id: definition.id,
		order: definition.order,
		title: definition.title,
		status: "pending",
		notes: [],
		updatedAt: nowIso,
	}));
}

function normalizePhaseStatus(status: unknown): PhaseStatus {
	switch (status) {
		case "pending":
		case "in_progress":
		case "completed":
		case "blocked":
			return status;
		default:
			return "pending";
	}
}

function normalizeTaskStatus(status: unknown): TaskStatus {
	switch (status) {
		case "pending":
		case "in_progress":
		case "completed":
		case "blocked":
		case "failed":
			return status;
		default:
			return "pending";
	}
}

function normalizeStringList(items: unknown): ReadonlyArray<string> {
	if (!Array.isArray(items)) return [];
	return items
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => item.length > 0);
}

function normalizeTasks(options: {
	readonly state: AnyDesignTrackerState;
	readonly nowIso: string;
	readonly phaseIds: ReadonlyArray<string>;
}): ReadonlyArray<DesignTask> {
	const rawTasks = "tasks" in options.state && Array.isArray(options.state.tasks) ? options.state.tasks : [];
	const phaseSet = new Set(options.phaseIds);
	const tasks: Array<DesignTask> = [];

	for (const rawTask of rawTasks) {
		if (!rawTask || typeof rawTask !== "object") continue;
		const candidate = rawTask as {
			readonly id?: unknown;
			readonly phaseId?: unknown;
			readonly title?: unknown;
			readonly owner?: unknown;
			readonly blockedBy?: unknown;
			readonly status?: unknown;
			readonly notes?: unknown;
			readonly updatedAt?: unknown;
		};
		const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
		if (!id) continue;
		const phaseId = typeof candidate.phaseId === "string" ? candidate.phaseId.trim() : "";
		if (!phaseSet.has(phaseId)) continue;
		const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
		if (!title) continue;

		const owner = typeof candidate.owner === "string" && candidate.owner.trim().length > 0 ? candidate.owner.trim() : null;
		const blockedBy = normalizeStringList(candidate.blockedBy);
		const status = normalizeTaskStatus(candidate.status);
		const notes = normalizeStringList(candidate.notes);
		const updatedAt = normalizeIso(candidate.updatedAt, options.nowIso);

		tasks.push({
			id,
			phaseId,
			title,
			owner,
			blockedBy,
			status,
			notes,
			updatedAt,
		});
	}

	const uniqueById = new Map<string, DesignTask>();
	for (const task of tasks) {
		uniqueById.set(task.id, task);
	}

	return syncTaskBlockState({
		tasks: Array.from(uniqueById.values()),
		nowIso: options.nowIso,
	});
}

function unresolvedDependencies(options: {
	readonly task: DesignTask;
	readonly taskMap: ReadonlyMap<string, DesignTask>;
}): ReadonlyArray<string> {
	return options.task.blockedBy.filter((dependencyId) => {
		const dependency = options.taskMap.get(dependencyId);
		if (!dependency) return true;
		return dependency.status !== "completed";
	});
}

function syncTaskBlockState(options: {
	readonly tasks: ReadonlyArray<DesignTask>;
	readonly nowIso: string;
}): ReadonlyArray<DesignTask> {
	const taskMap = new Map<string, DesignTask>();
	for (const task of options.tasks) {
		taskMap.set(task.id, task);
	}

	return options.tasks.map((task) => {
		if (task.status === "completed" || task.status === "failed") {
			return task;
		}

		const unresolved = unresolvedDependencies({ task, taskMap });
		if (unresolved.length > 0) {
			if (task.status === "blocked") return task;
			return {
				...task,
				status: "blocked",
				updatedAt: options.nowIso,
			};
		}

		if (task.status === "blocked") {
			return {
				...task,
				status: "pending",
				updatedAt: options.nowIso,
			};
		}

		return task;
	});
}

function normalizeStateTopic(topic: unknown): string {
	if (typeof topic !== "string") return "Design plan";
	const trimmed = topic.trim();
	return trimmed.length > 0 ? trimmed : "Design plan";
}

export function normalizeTrackerState(options: {
	readonly state: AnyDesignTrackerState;
	readonly nowIso: string;
}): DesignTrackerState {
	const phaseLookup = new Map<string, DesignPhase>();
	for (const phase of options.state.phases ?? []) {
		phaseLookup.set(phase.id, phase);
	}

	const phases: ReadonlyArray<DesignPhase> = DEFAULT_PHASES.map((definition) => {
		const existing = phaseLookup.get(definition.id);
		if (!existing) {
			return {
				id: definition.id,
				order: definition.order,
				title: definition.title,
				status: "pending",
				notes: [],
				updatedAt: options.nowIso,
			};
		}

		return {
			id: definition.id,
			order: definition.order,
			title: definition.title,
			status: normalizePhaseStatus(existing.status),
			notes: normalizeStringList(existing.notes),
			updatedAt: normalizeIso(existing.updatedAt, options.nowIso),
		};
	});

	const tasks = normalizeTasks({
		state: options.state,
		nowIso: options.nowIso,
		phaseIds: phases.map((phase) => phase.id),
	});

	const designPath =
		typeof options.state.designPath === "string" && options.state.designPath.trim().length > 0
			? options.state.designPath.trim()
			: null;

	return {
		version: 2,
		topic: normalizeStateTopic(options.state.topic),
		startedAt: normalizeIso(options.state.startedAt, options.nowIso),
		updatedAt: normalizeIso(options.state.updatedAt, options.nowIso),
		designPath,
		phases,
		tasks,
	};
}

export function createInitialTrackerState(options: {
	readonly topic: string;
	readonly nowIso: string;
}): TrackerMutationResult {
	const topic = normalizeTopic(options.topic);
	if (!topic) {
		return { ok: false, error: "Topic is required" };
	}

	const state: DesignTrackerState = {
		version: 2,
		topic,
		startedAt: options.nowIso,
		updatedAt: options.nowIso,
		designPath: null,
		phases: buildInitialPhases(options.nowIso),
		tasks: [],
	};

	return { ok: true, state };
}

export function deriveCurrentPhaseId(state: DesignTrackerState): string | null {
	const inProgress = state.phases.find((phase) => phase.status === "in_progress");
	if (inProgress) return inProgress.id;

	const firstPending = state.phases.find((phase) => phase.status === "pending");
	if (firstPending) return firstPending.id;

	const blocked = state.phases.find((phase) => phase.status === "blocked");
	if (blocked) return blocked.id;

	return null;
}

function validatePhaseTransition(options: {
	readonly state: DesignTrackerState;
	readonly phaseIndex: number;
	readonly status: PhaseStatus;
}): { readonly ok: true } | { readonly ok: false; readonly error: string } {
	const phase = options.state.phases[options.phaseIndex];
	if (!phase) {
		return { ok: false, error: "Unknown phase" };
	}

	if (options.status === "completed") {
		for (let index = 0; index < options.phaseIndex; index += 1) {
			const prior = options.state.phases[index];
			if (prior.status !== "completed") {
				return {
					ok: false,
					error: `Cannot complete ${phase.title} before ${prior.title} is completed`,
				};
			}
		}
	}

	if (options.status === "in_progress") {
		for (let index = 0; index < options.phaseIndex; index += 1) {
			const prior = options.state.phases[index];
			if (prior.status !== "completed") {
				return {
					ok: false,
					error: `Cannot start ${phase.title} before ${prior.title} is completed`,
				};
			}
		}
	}

	return { ok: true };
}

export function setPhaseStatus(options: {
	readonly state: DesignTrackerState;
	readonly phaseId: string;
	readonly status: PhaseStatus;
	readonly nowIso: string;
}): TrackerMutationResult {
	const phaseIndex = findPhaseIndex(options.state.phases, options.phaseId);
	if (phaseIndex < 0) {
		return { ok: false, error: `Unknown phase id: ${options.phaseId}` };
	}

	const transition = validatePhaseTransition({
		state: options.state,
		phaseIndex,
		status: options.status,
	});
	if (!transition.ok) {
		return { ok: false, error: transition.error };
	}

	const phases = options.state.phases.map((phase, index) => {
		if (index !== phaseIndex) {
			if (options.status === "in_progress" && phase.status === "in_progress") {
				return {
					...phase,
					status: "pending" as const,
					updatedAt: options.nowIso,
				};
			}
			return phase;
		}

		return {
			...phase,
			status: options.status,
			updatedAt: options.nowIso,
		};
	});

	const nextState: DesignTrackerState = {
		...options.state,
		phases,
		updatedAt: options.nowIso,
	};

	return { ok: true, state: nextState };
}

export function appendPhaseNote(options: {
	readonly state: DesignTrackerState;
	readonly phaseId: string;
	readonly note: string;
	readonly nowIso: string;
}): TrackerMutationResult {
	const phaseIndex = findPhaseIndex(options.state.phases, options.phaseId);
	if (phaseIndex < 0) {
		return { ok: false, error: `Unknown phase id: ${options.phaseId}` };
	}

	const note = options.note.trim();
	if (!note) {
		return { ok: false, error: "Note must not be empty" };
	}

	const phases = options.state.phases.map((phase, index) => {
		if (index !== phaseIndex) return phase;
		return {
			...phase,
			notes: [...phase.notes, note],
			updatedAt: options.nowIso,
		};
	});

	const nextState: DesignTrackerState = {
		...options.state,
		phases,
		updatedAt: options.nowIso,
	};

	return { ok: true, state: nextState };
}

export function setDesignPath(options: {
	readonly state: DesignTrackerState;
	readonly designPath: string;
	readonly nowIso: string;
}): TrackerMutationResult {
	const designPath = options.designPath.trim();
	if (!designPath) {
		return { ok: false, error: "designPath must not be empty" };
	}

	const nextState: DesignTrackerState = {
		...options.state,
		designPath,
		updatedAt: options.nowIso,
	};

	return { ok: true, state: nextState };
}

function nextTaskId(state: DesignTrackerState): string {
	let maxIndex = 0;
	for (const task of state.tasks) {
		const match = task.id.match(/^task-(\d+)$/);
		if (!match) continue;
		const value = Number.parseInt(match[1], 10);
		if (Number.isFinite(value) && value > maxIndex) {
			maxIndex = value;
		}
	}
	return `task-${maxIndex + 1}`;
}

export function addTask(options: {
	readonly state: DesignTrackerState;
	readonly phaseId: string;
	readonly title: string;
	readonly blockedBy: ReadonlyArray<string>;
	readonly owner: string | null;
	readonly taskId?: string;
	readonly nowIso: string;
}): TrackerMutationResult {
	const phaseExists = options.state.phases.some((phase) => phase.id === options.phaseId);
	if (!phaseExists) {
		return { ok: false, error: `Unknown phase id: ${options.phaseId}` };
	}

	const title = options.title.trim();
	if (!title) {
		return { ok: false, error: "Task title must not be empty" };
	}

	const requestedId = options.taskId?.trim();
	const id = requestedId && requestedId.length > 0 ? requestedId : nextTaskId(options.state);
	if (findTaskIndex(options.state.tasks, id) >= 0) {
		return { ok: false, error: `Task id already exists: ${id}` };
	}

	const blockedBy = options.blockedBy.map((dependency) => dependency.trim()).filter((dependency) => dependency.length > 0);
	for (const dependency of blockedBy) {
		if (findTaskIndex(options.state.tasks, dependency) < 0) {
			return { ok: false, error: `Blocked dependency not found: ${dependency}` };
		}
	}

	const owner = options.owner && options.owner.trim().length > 0 ? options.owner.trim() : null;
	const newTask: DesignTask = {
		id,
		phaseId: options.phaseId,
		title,
		owner,
		blockedBy,
		status: "pending",
		notes: [],
		updatedAt: options.nowIso,
	};

	const tasks = syncTaskBlockState({
		tasks: [...options.state.tasks, newTask],
		nowIso: options.nowIso,
	});

	return {
		ok: true,
		state: {
			...options.state,
			tasks,
			updatedAt: options.nowIso,
		},
	};
}

export function setTaskStatus(options: {
	readonly state: DesignTrackerState;
	readonly taskId: string;
	readonly status: TaskStatus;
	readonly nowIso: string;
}): TrackerMutationResult {
	const taskIndex = findTaskIndex(options.state.tasks, options.taskId);
	if (taskIndex < 0) {
		return { ok: false, error: `Unknown task id: ${options.taskId}` };
	}

	const task = options.state.tasks[taskIndex];
	const taskMap = new Map(options.state.tasks.map((entry) => [entry.id, entry] as const));
	const unresolved = unresolvedDependencies({ task, taskMap });

	if ((options.status === "in_progress" || options.status === "completed") && unresolved.length > 0) {
		return {
			ok: false,
			error: `Task ${task.id} is blocked by: ${unresolved.join(", ")}`,
		};
	}

	const nextTasks = options.state.tasks.map((entry, index) => {
		if (index !== taskIndex) return entry;
		return {
			...entry,
			status: options.status,
			updatedAt: options.nowIso,
		};
	});

	const syncedTasks = syncTaskBlockState({
		tasks: nextTasks,
		nowIso: options.nowIso,
	});

	return {
		ok: true,
		state: {
			...options.state,
			tasks: syncedTasks,
			updatedAt: options.nowIso,
		},
	};
}

export function appendTaskNote(options: {
	readonly state: DesignTrackerState;
	readonly taskId: string;
	readonly note: string;
	readonly nowIso: string;
}): TrackerMutationResult {
	const taskIndex = findTaskIndex(options.state.tasks, options.taskId);
	if (taskIndex < 0) {
		return { ok: false, error: `Unknown task id: ${options.taskId}` };
	}

	const note = options.note.trim();
	if (!note) {
		return { ok: false, error: "Task note must not be empty" };
	}

	const tasks = options.state.tasks.map((task, index) => {
		if (index !== taskIndex) return task;
		return {
			...task,
			notes: [...task.notes, note],
			updatedAt: options.nowIso,
		};
	});

	return {
		ok: true,
		state: {
			...options.state,
			tasks,
			updatedAt: options.nowIso,
		},
	};
}

export function listTasks(options: {
	readonly state: DesignTrackerState;
	readonly phaseId?: string;
}): ReadonlyArray<DesignTask> {
	if (!options.phaseId) return options.state.tasks;
	return options.state.tasks.filter((task) => task.phaseId === options.phaseId);
}
