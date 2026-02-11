import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	TRACKER_ENTRY_TYPE,
	appendPhaseNote,
	createInitialTrackerState,
	deriveCurrentPhaseId,
	setDesignPath,
	setPhaseStatus,
	normalizeTrackerState,
} from "../core/state";
import type { DesignTrackerState, PhaseStatus } from "../core/types";

type TrackerBinding = {
	readonly getState: () => DesignTrackerState | null;
	readonly setState: (state: DesignTrackerState | null) => void;
	readonly onChange: (ctx: ExtensionContext) => void;
};

type TrackerToolDetails = {
	readonly state: DesignTrackerState | null;
	readonly currentPhaseId: string | null;
	readonly message: string;
};

const STATUS_SCHEMA = StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
	description: "Phase status",
});

const ACTION_SCHEMA = StringEnum(
	["create", "get", "set_status", "append_note", "set_design_path", "reset"] as const,
	{ description: "Tracker action" },
);

const TRACKER_PARAMS = Type.Object({
	action: ACTION_SCHEMA,
	topic: Type.Optional(Type.String({ description: "Topic for create action" })),
	phaseId: Type.Optional(Type.String({ description: "Phase id (phase-1 ... phase-5)" })),
	status: Type.Optional(STATUS_SCHEMA),
	note: Type.Optional(Type.String({ description: "Note to append to phase" })),
	designPath: Type.Optional(Type.String({ description: "Path to the design document" })),
	force: Type.Optional(Type.Boolean({ description: "Force create over existing state" })),
});

function toDetails(state: DesignTrackerState | null, message: string): TrackerToolDetails {
	return {
		state,
		currentPhaseId: state ? deriveCurrentPhaseId(state) : null,
		message,
	};
}

function persistState(pi: ExtensionAPI, state: DesignTrackerState | null): void {
	pi.appendEntry(TRACKER_ENTRY_TYPE, { state });
}

function asTrackerState(value: unknown): DesignTrackerState | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as { readonly version?: unknown; readonly phases?: unknown };
	if (candidate.version !== 1) return null;
	if (!Array.isArray(candidate.phases)) return null;
	return value as DesignTrackerState;
}

export function reconstructTrackerState(ctx: ExtensionContext): DesignTrackerState | null {
	let latest: DesignTrackerState | null = null;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom") continue;
		if (entry.customType !== TRACKER_ENTRY_TYPE) continue;
		const data = entry.data as { readonly state?: unknown } | undefined;
		if (!data || !("state" in data)) continue;
		if (data.state === null) {
			latest = null;
			continue;
		}
		const parsed = asTrackerState(data.state);
		if (parsed) {
			latest = normalizeTrackerState({
				state: parsed,
				nowIso: new Date().toISOString(),
			});
		}
	}
	return latest;
}

function requireState(state: DesignTrackerState | null):
	| { readonly ok: true; readonly state: DesignTrackerState }
	| { readonly ok: false; readonly error: string } {
	if (!state) {
		return { ok: false, error: "Tracker is not initialized. Call action=create first." };
	}
	return { ok: true, state };
}

export function registerDesignPlanTrackerTool(
	pi: ExtensionAPI,
	binding: TrackerBinding,
): void {
	pi.registerTool({
		name: "design_plan_tracker",
		label: "Design Plan Tracker",
		description:
			"Track /start-design-plan phase progress. Actions: create, get, set_status, append_note, set_design_path, reset.",
		parameters: TRACKER_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const nowIso = new Date().toISOString();
			const current = binding.getState();

			switch (params.action) {
				case "create": {
					if (current && params.force !== true) {
						return {
							content: [{ type: "text", text: "Tracker already exists. Use force=true to recreate." }],
							isError: true,
							details: toDetails(current, "Tracker already exists"),
						};
					}
					const topic = params.topic?.trim() || "Design plan";
					const created = createInitialTrackerState({ topic, nowIso });
					if (!created.ok) {
						return {
							content: [{ type: "text", text: created.error }],
							isError: true,
							details: toDetails(current, created.error),
						};
					}
					binding.setState(created.state);
					persistState(pi, created.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Tracker created for topic: ${created.state.topic}` }],
						details: toDetails(created.state, "Tracker created"),
					};
				}

				case "get": {
					return {
						content: [{ type: "text", text: JSON.stringify(toDetails(current, "Tracker snapshot"), null, 2) }],
						details: toDetails(current, "Tracker snapshot"),
					};
				}

				case "set_status": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails(current, required.error),
						};
					}
					const phaseId = params.phaseId?.trim();
					const status = params.status as PhaseStatus | undefined;
					if (!phaseId || !status) {
						return {
							content: [{ type: "text", text: "phaseId and status are required" }],
							isError: true,
							details: toDetails(required.state, "Missing phaseId or status"),
						};
					}
					const updated = setPhaseStatus({
						state: required.state,
						phaseId,
						status,
						nowIso,
					});
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails(required.state, updated.error),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Updated ${phaseId} to ${status}` }],
						details: toDetails(updated.state, `Updated ${phaseId} to ${status}`),
					};
				}

				case "append_note": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails(current, required.error),
						};
					}
					const phaseId = params.phaseId?.trim();
					const note = params.note ?? "";
					if (!phaseId) {
						return {
							content: [{ type: "text", text: "phaseId is required" }],
							isError: true,
							details: toDetails(required.state, "Missing phaseId"),
						};
					}
					const updated = appendPhaseNote({
						state: required.state,
						phaseId,
						note,
						nowIso,
					});
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails(required.state, updated.error),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Appended note to ${phaseId}` }],
						details: toDetails(updated.state, `Appended note to ${phaseId}`),
					};
				}

				case "set_design_path": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails(current, required.error),
						};
					}
					const designPath = params.designPath ?? "";
					const updated = setDesignPath({ state: required.state, designPath, nowIso });
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails(required.state, updated.error),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Set design path: ${updated.state.designPath}` }],
						details: toDetails(updated.state, "Design path updated"),
					};
				}

				case "reset": {
					binding.setState(null);
					persistState(pi, null);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: "Tracker reset" }],
						details: toDetails(null, "Tracker reset"),
					};
				}
			}
		},
		renderCall(args, theme) {
			const action = args.action ?? "get";
			const phase = args.phaseId ? ` ${args.phaseId}` : "";
			return new Text(theme.fg("toolTitle", theme.bold("design_plan_tracker ")) + theme.fg("muted", `${action}${phase}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as TrackerToolDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (!details.state) {
				return new Text(theme.fg("muted", details.message), 0, 0);
			}
			const current = details.currentPhaseId ?? "none";
			return new Text(theme.fg("success", `✓ ${details.message} (current: ${current})`), 0, 0);
		},
	});
}
