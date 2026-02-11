import type { DesignPhase, DesignTrackerState, PhaseDefinition, PhaseStatus, TrackerMutationResult } from "./types";

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

function findPhaseIndex(
	phases: ReadonlyArray<DesignPhase>,
	phaseId: string,
): number {
	return phases.findIndex((phase) => phase.id === phaseId);
}

function normalizeTopic(topic: string): string {
	return topic.trim();
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

function normalizePhaseNotes(notes: unknown): ReadonlyArray<string> {
	if (!Array.isArray(notes)) return [];
	return notes
		.filter((note): note is string => typeof note === "string")
		.map((note) => note.trim())
		.filter((note) => note.length > 0);
}

export function normalizeTrackerState(options: {
	readonly state: DesignTrackerState;
	readonly nowIso: string;
}): DesignTrackerState {
	const phaseLookup = new Map<string, DesignPhase>();
	for (const phase of options.state.phases) {
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
			notes: normalizePhaseNotes(existing.notes),
			updatedAt:
				typeof existing.updatedAt === "string" && existing.updatedAt.trim().length > 0
					? existing.updatedAt
					: options.nowIso,
		};
	});

	const topic = options.state.topic.trim();
	return {
		version: 1,
		topic: topic || "Design plan",
		startedAt:
			typeof options.state.startedAt === "string" && options.state.startedAt.trim().length > 0
				? options.state.startedAt
				: options.nowIso,
		updatedAt:
			typeof options.state.updatedAt === "string" && options.state.updatedAt.trim().length > 0
				? options.state.updatedAt
				: options.nowIso,
		designPath:
			typeof options.state.designPath === "string" && options.state.designPath.trim().length > 0
				? options.state.designPath.trim()
				: null,
		phases,
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
		version: 1,
		topic,
		startedAt: options.nowIso,
		updatedAt: options.nowIso,
		designPath: null,
		phases: buildInitialPhases(options.nowIso),
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
