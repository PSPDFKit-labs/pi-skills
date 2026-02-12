import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	TRACKER_ENTRY_TYPE,
	addTask,
	appendPhaseNote,
	appendTaskNote,
	createInitialTrackerState,
	deriveCurrentPhaseId,
	listTasks,
	normalizeTrackerState,
	setDesignPath,
	setPhaseStatus,
	setTaskStatus,
} from "../core/state";
import type { AnyDesignTrackerState, DesignTask, DesignTrackerState, PhaseStatus, TaskStatus } from "../core/types";

type TrackerBinding = {
	readonly getState: () => DesignTrackerState | null;
	readonly setState: (state: DesignTrackerState | null) => void;
	readonly onChange: (ctx: ExtensionContext) => void;
};

type TrackerToolDetails = {
	readonly state: DesignTrackerState | null;
	readonly currentPhaseId: string | null;
	readonly message: string;
	readonly tasks?: ReadonlyArray<DesignTask>;
};

const PHASE_STATUS_SCHEMA = StringEnum(["pending", "in_progress", "completed", "blocked"] as const, {
	description: "Phase status",
});

const TASK_STATUS_SCHEMA = StringEnum(
	["pending", "in_progress", "completed", "blocked", "failed"] as const,
	{ description: "Task status" },
);

const ACTION_SCHEMA = StringEnum(
	[
		"create",
		"get",
		"set_status",
		"append_note",
		"set_design_path",
		"add_task",
		"set_task_status",
		"append_task_note",
		"list_tasks",
		"reset",
	] as const,
	{ description: "Tracker action" },
);

const TRACKER_PARAMS = Type.Object({
	action: ACTION_SCHEMA,
	topic: Type.Optional(Type.String({ description: "Topic for create action" })),
	phaseId: Type.Optional(Type.String({ description: "Phase id (phase-1 ... phase-5)" })),
	status: Type.Optional(PHASE_STATUS_SCHEMA),
	note: Type.Optional(Type.String({ description: "Note to append to a phase" })),
	designPath: Type.Optional(Type.String({ description: "Path to the design document" })),
	taskId: Type.Optional(Type.String({ description: "Task id" })),
	title: Type.Optional(Type.String({ description: "Task title for add_task" })),
	blockedBy: Type.Optional(Type.Array(Type.String({ description: "Task ids this task depends on" }))),
	owner: Type.Optional(Type.String({ description: "Optional owner label for task" })),
	taskStatus: Type.Optional(TASK_STATUS_SCHEMA),
	force: Type.Optional(Type.Boolean({ description: "Force create over existing state" })),
});

function toDetails(options: {
	readonly state: DesignTrackerState | null;
	readonly message: string;
	readonly tasks?: ReadonlyArray<DesignTask>;
}): TrackerToolDetails {
	return {
		state: options.state,
		currentPhaseId: options.state ? deriveCurrentPhaseId(options.state) : null,
		message: options.message,
		tasks: options.tasks,
	};
}

function persistState(pi: ExtensionAPI, state: DesignTrackerState | null): void {
	pi.appendEntry(TRACKER_ENTRY_TYPE, { state });
}

function asTrackerState(value: unknown): AnyDesignTrackerState | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as { readonly version?: unknown; readonly phases?: unknown };
	if (candidate.version !== 1 && candidate.version !== 2) return null;
	if (!Array.isArray(candidate.phases)) return null;
	return value as AnyDesignTrackerState;
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
		if (!parsed) continue;
		latest = normalizeTrackerState({
			state: parsed,
			nowIso: new Date().toISOString(),
		});
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

function taskSummary(tasks: ReadonlyArray<DesignTask>): string {
	const completed = tasks.filter((task) => task.status === "completed").length;
	const blocked = tasks.filter((task) => task.status === "blocked").length;
	const inProgress = tasks.filter((task) => task.status === "in_progress").length;
	return `${completed}/${tasks.length} complete • ${inProgress} in progress • ${blocked} blocked`;
}

export function registerDesignPlanTrackerTool(pi: ExtensionAPI, binding: TrackerBinding): void {
	pi.registerTool({
		name: "design_plan_tracker",
		label: "Design Plan Tracker",
		description:
			"Track /start-design-plan phase and task progress. Actions: create, get, set_status, append_note, set_design_path, add_task, set_task_status, append_task_note, list_tasks, reset.",
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
							details: toDetails({ state: current, message: "Tracker already exists" }),
						};
					}
					const topic = params.topic?.trim() || "Design plan";
					const created = createInitialTrackerState({ topic, nowIso });
					if (!created.ok) {
						return {
							content: [{ type: "text", text: created.error }],
							isError: true,
							details: toDetails({ state: current, message: created.error }),
						};
					}
					binding.setState(created.state);
					persistState(pi, created.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Tracker created for topic: ${created.state.topic}` }],
						details: toDetails({ state: created.state, message: "Tracker created" }),
					};
				}

				case "get": {
					const details = toDetails({ state: current, message: "Tracker snapshot", tasks: current?.tasks });
					return {
						content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
						details,
					};
				}

				case "set_status": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const phaseId = params.phaseId?.trim();
					const status = params.status as PhaseStatus | undefined;
					if (!phaseId || !status) {
						return {
							content: [{ type: "text", text: "phaseId and status are required" }],
							isError: true,
							details: toDetails({ state: required.state, message: "Missing phaseId or status" }),
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
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Updated ${phaseId} to ${status}` }],
						details: toDetails({ state: updated.state, message: `Updated ${phaseId} to ${status}` }),
					};
				}

				case "append_note": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const phaseId = params.phaseId?.trim();
					const note = params.note ?? "";
					if (!phaseId) {
						return {
							content: [{ type: "text", text: "phaseId is required" }],
							isError: true,
							details: toDetails({ state: required.state, message: "Missing phaseId" }),
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
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Appended note to ${phaseId}` }],
						details: toDetails({ state: updated.state, message: `Appended note to ${phaseId}` }),
					};
				}

				case "set_design_path": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const designPath = params.designPath ?? "";
					const updated = setDesignPath({ state: required.state, designPath, nowIso });
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Set design path: ${updated.state.designPath}` }],
						details: toDetails({ state: updated.state, message: "Design path updated" }),
					};
				}

				case "add_task": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const phaseId = params.phaseId?.trim();
					const title = params.title?.trim();
					if (!phaseId || !title) {
						return {
							content: [{ type: "text", text: "phaseId and title are required for add_task" }],
							isError: true,
							details: toDetails({ state: required.state, message: "Missing phaseId/title" }),
						};
					}
					const updated = addTask({
						state: required.state,
						phaseId,
						title,
						blockedBy: params.blockedBy ?? [],
						owner: params.owner?.trim() || null,
						taskId: params.taskId?.trim(),
						nowIso,
					});
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Added task in ${phaseId}: ${title}` }],
						details: toDetails({
							state: updated.state,
							message: `Task added (${taskSummary(updated.state.tasks)})`,
							tasks: updated.state.tasks,
						}),
					};
				}

				case "set_task_status": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const taskId = params.taskId?.trim();
					const status = params.taskStatus as TaskStatus | undefined;
					if (!taskId || !status) {
						return {
							content: [{ type: "text", text: "taskId and taskStatus are required" }],
							isError: true,
							details: toDetails({ state: required.state, message: "Missing taskId/taskStatus" }),
						};
					}
					const updated = setTaskStatus({
						state: required.state,
						taskId,
						status,
						nowIso,
					});
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Updated task ${taskId} to ${status}` }],
						details: toDetails({
							state: updated.state,
							message: `Task updated (${taskSummary(updated.state.tasks)})`,
							tasks: updated.state.tasks,
						}),
					};
				}

				case "append_task_note": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const taskId = params.taskId?.trim();
					const note = params.note ?? "";
					if (!taskId) {
						return {
							content: [{ type: "text", text: "taskId is required" }],
							isError: true,
							details: toDetails({ state: required.state, message: "Missing taskId" }),
						};
					}
					const updated = appendTaskNote({ state: required.state, taskId, note, nowIso });
					if (!updated.ok) {
						return {
							content: [{ type: "text", text: updated.error }],
							isError: true,
							details: toDetails({ state: required.state, message: updated.error }),
						};
					}
					binding.setState(updated.state);
					persistState(pi, updated.state);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: `Appended note to task ${taskId}` }],
						details: toDetails({ state: updated.state, message: "Task note appended", tasks: updated.state.tasks }),
					};
				}

				case "list_tasks": {
					const required = requireState(current);
					if (!required.ok) {
						return {
							content: [{ type: "text", text: required.error }],
							isError: true,
							details: toDetails({ state: current, message: required.error }),
						};
					}
					const phaseId = params.phaseId?.trim();
					const tasks = listTasks({ state: required.state, phaseId });
					const payload = {
						phaseId: phaseId ?? null,
						total: tasks.length,
						tasks,
					};
					return {
						content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
						details: toDetails({
							state: required.state,
							message: `Task list (${taskSummary(tasks)})`,
							tasks,
						}),
					};
				}

				case "reset": {
					binding.setState(null);
					persistState(pi, null);
					binding.onChange(ctx);
					return {
						content: [{ type: "text", text: "Tracker reset" }],
						details: toDetails({ state: null, message: "Tracker reset" }),
					};
				}
			}
		},
		renderCall(args, theme) {
			const action = args.action ?? "get";
			const suffix = args.phaseId ? ` ${args.phaseId}` : args.taskId ? ` ${args.taskId}` : "";
			return new Text(
				theme.fg("toolTitle", theme.bold("design_plan_tracker ")) + theme.fg("muted", `${action}${suffix}`),
				0,
				0,
			);
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
			const taskInfo = details.tasks ? ` • tasks ${taskSummary(details.tasks)}` : "";
			return new Text(theme.fg("success", `✓ ${details.message} (current: ${current}${taskInfo})`), 0, 0);
		},
	});
}
