export type PhaseStatus = "pending" | "in_progress" | "completed" | "blocked";

export type DesignPhase = {
	readonly id: string;
	readonly order: number;
	readonly title: string;
	readonly status: PhaseStatus;
	readonly notes: ReadonlyArray<string>;
	readonly updatedAt: string;
};

export type DesignTrackerState = {
	readonly version: 1;
	readonly topic: string;
	readonly startedAt: string;
	readonly updatedAt: string;
	readonly designPath: string | null;
	readonly phases: ReadonlyArray<DesignPhase>;
};

export type PhaseDefinition = {
	readonly id: string;
	readonly order: number;
	readonly title: string;
};

export type TrackerMutationResult =
	| {
			readonly ok: true;
			readonly state: DesignTrackerState;
	  }
	| {
			readonly ok: false;
			readonly error: string;
	  };
