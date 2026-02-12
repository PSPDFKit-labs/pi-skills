import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

export type DesignPlanConfig = {
	readonly version: 1;
	readonly researchModel: string | null;
	readonly researchMaxAgents: number;
	readonly researchIncludeInternet: boolean;
};

// Legacy session entry type kept for backward compatibility reads.
export const DESIGN_PLAN_CONFIG_ENTRY_TYPE = "start-design-plan-config";

const DESIGN_PLAN_CONFIG_FILE_NAME = "design-plan-config.json";

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

function findProjectRoot(startCwd: string): string {
	let current = path.resolve(startCwd);
	while (true) {
		if (existsSync(path.join(current, ".pi")) || existsSync(path.join(current, ".git"))) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return path.resolve(startCwd);
		}
		current = parent;
	}
}

function getConfigPathFromCwd(cwd: string): string {
	const projectRoot = findProjectRoot(cwd);
	return path.join(projectRoot, ".pi", DESIGN_PLAN_CONFIG_FILE_NAME);
}

function readConfigFromFile(filePath: string): DesignPlanConfig | null {
	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		return normalizeDesignPlanConfig(parsed);
	} catch {
		return null;
	}
}

function reconstructLegacySessionConfig(ctx: ExtensionContext): DesignPlanConfig {
	let latest: DesignPlanConfig = DEFAULT_DESIGN_PLAN_CONFIG;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== DESIGN_PLAN_CONFIG_ENTRY_TYPE) continue;
		latest = normalizeDesignPlanConfig(entry.data);
	}
	return latest;
}

export function persistDesignPlanConfig(options: {
	readonly cwd: string;
	readonly config: DesignPlanConfig;
}): void {
	const filePath = getConfigPathFromCwd(options.cwd);
	const directoryPath = path.dirname(filePath);
	mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
	writeFileSync(filePath, `${JSON.stringify(options.config, null, 2)}\n`, "utf8");
}

export function reconstructDesignPlanConfig(ctx: ExtensionContext): DesignPlanConfig {
	const filePath = getConfigPathFromCwd(ctx.cwd);
	const fromFile = readConfigFromFile(filePath);
	if (fromFile) {
		return fromFile;
	}

	const legacy = reconstructLegacySessionConfig(ctx);
	if (legacy !== DEFAULT_DESIGN_PLAN_CONFIG) {
		persistDesignPlanConfig({ cwd: ctx.cwd, config: legacy });
	}
	return legacy;
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
