import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type DesignPlanConfig = {
	readonly version: 1;
	readonly researchModel: string | null;
	readonly researchMaxAgents: number;
	readonly researchIncludeInternet: boolean;
};

export const DESIGN_PLAN_CONFIG_ENTRY_TYPE = "start-design-plan-config";

export const DEFAULT_DESIGN_PLAN_CONFIG: DesignPlanConfig = {
	version: 1,
	researchModel: null,
	researchMaxAgents: 3,
	researchIncludeInternet: true,
};

function normalizeResearchModel(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function normalizeResearchMaxAgents(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return DEFAULT_DESIGN_PLAN_CONFIG.researchMaxAgents;
	}
	return Math.max(1, Math.min(4, Math.floor(value)));
}

function normalizeResearchIncludeInternet(value: unknown): boolean {
	if (typeof value !== "boolean") return DEFAULT_DESIGN_PLAN_CONFIG.researchIncludeInternet;
	return value;
}

export function normalizeDesignPlanConfig(value: unknown): DesignPlanConfig {
	if (!value || typeof value !== "object") {
		return DEFAULT_DESIGN_PLAN_CONFIG;
	}

	const candidate = value as {
		readonly version?: unknown;
		readonly researchModel?: unknown;
		readonly researchMaxAgents?: unknown;
		readonly researchIncludeInternet?: unknown;
	};

	if (candidate.version !== 1) {
		return {
			...DEFAULT_DESIGN_PLAN_CONFIG,
			researchModel: normalizeResearchModel(candidate.researchModel),
			researchMaxAgents: normalizeResearchMaxAgents(candidate.researchMaxAgents),
			researchIncludeInternet: normalizeResearchIncludeInternet(candidate.researchIncludeInternet),
		};
	}

	return {
		version: 1,
		researchModel: normalizeResearchModel(candidate.researchModel),
		researchMaxAgents: normalizeResearchMaxAgents(candidate.researchMaxAgents),
		researchIncludeInternet: normalizeResearchIncludeInternet(candidate.researchIncludeInternet),
	};
}

export function persistDesignPlanConfig(pi: ExtensionAPI, config: DesignPlanConfig): void {
	pi.appendEntry(DESIGN_PLAN_CONFIG_ENTRY_TYPE, config);
}

export function reconstructDesignPlanConfig(ctx: ExtensionContext): DesignPlanConfig {
	let latest: DesignPlanConfig = DEFAULT_DESIGN_PLAN_CONFIG;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== DESIGN_PLAN_CONFIG_ENTRY_TYPE) continue;
		latest = normalizeDesignPlanConfig(entry.data);
	}
	return latest;
}

export function withDesignPlanConfigPatch(options: {
	readonly config: DesignPlanConfig;
	readonly patch: Partial<Omit<DesignPlanConfig, "version">>;
}): DesignPlanConfig {
	return normalizeDesignPlanConfig({
		version: 1,
		researchModel:
			options.patch.researchModel !== undefined ? options.patch.researchModel : options.config.researchModel,
		researchMaxAgents:
			options.patch.researchMaxAgents !== undefined
				? options.patch.researchMaxAgents
				: options.config.researchMaxAgents,
		researchIncludeInternet:
			options.patch.researchIncludeInternet !== undefined
				? options.patch.researchIncludeInternet
				: options.config.researchIncludeInternet,
	});
}
