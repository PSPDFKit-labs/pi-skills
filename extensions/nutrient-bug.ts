import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	truncateHead,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Container, Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type IssueRefs = {
	readonly zendeskId: number | null;
	readonly jiraKey: string | null;
};

type TicketComment = {
	readonly authorId: string | null;
	readonly createdAt: string | null;
	readonly isPublic: boolean | null;
	readonly body: string;
};

type ZendeskContext = {
	readonly id: number;
	readonly subject: string;
	readonly status: string | null;
	readonly priority: string | null;
	readonly url: string | null;
	readonly description: string;
	readonly comments: Array<TicketComment>;
};

type JiraComment = {
	readonly author: string | null;
	readonly createdAt: string | null;
	readonly body: string;
};

type JiraContext = {
	readonly key: string;
	readonly summary: string;
	readonly status: string | null;
	readonly assignee: string | null;
	readonly url: string | null;
	readonly description: string;
	readonly comments: Array<JiraComment>;
};

type CombinedContext = {
	readonly refs: IssueRefs;
	readonly zendesk: ZendeskContext | null;
	readonly jira: JiraContext | null;
	readonly fetchedAt: string;
};

type IssueState = {
	readonly refs: IssueRefs;
	readonly context: CombinedContext | null;
};

type ParsedRefs = {
	readonly refs: IssueRefs;
	readonly changed: boolean;
};

type JsonResult =
	| {
			readonly success: true;
			readonly json: unknown;
	  }
	| {
			readonly success: false;
			readonly error: string;
	  };

const ISSUE_STATE_ENTRY = "nutrient-issue-state";

const emptyState = (): IssueState => ({
	refs: { zendeskId: null, jiraKey: null },
	context: null,
});

const parseJson = (text: string): JsonResult => {
	try {
		return { success: true, json: JSON.parse(text) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: `failed to parse json output: ${message}` };
	}
};

const coerceString = (value: unknown): string | null => {
	if (typeof value !== "string") {
		return null;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const coerceNumber = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isInteger(value) && value > 0) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return null;
};

const toZendeskBrowserUrl = (ticketApiUrl: string | null, ticketId: number): string | null => {
	if (!ticketApiUrl) {
		return null;
	}
	try {
		const parsed = new URL(ticketApiUrl);
		return `${parsed.origin}/agent/tickets/${ticketId}`;
	} catch {
		return null;
	}
};

const toJiraBrowserUrl = (issueSelfUrl: string | null, issueKey: string): string | null => {
	if (!issueSelfUrl) {
		return null;
	}
	try {
		const parsed = new URL(issueSelfUrl);
		return `${parsed.origin}/browse/${issueKey}`;
	} catch {
		return null;
	}
};

const openUrlInBrowser = async (pi: ExtensionAPI, url: string): Promise<void> => {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "darwin"
		? [url]
		: platform === "win32"
			? ["/c", "start", "", url]
			: [url];

	const result = await pi.exec(command, args);
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `failed to open url: ${url}`;
		throw new Error(detail);
	}
};

const summarizeRefs = (refs: IssueRefs): string => {
	const parts: Array<string> = [];
	if (refs.zendeskId) {
		parts.push(`Zendesk #${refs.zendeskId}`);
	}
	if (refs.jiraKey) {
		parts.push(`Jira ${refs.jiraKey}`);
	}
	if (parts.length === 0) {
		return "No active nutrient issue";
	}
	return parts.join(" + ");
};

const parseBugCommandArgs = (args: string, previous: IssueRefs): ParsedRefs => {
	const tokens = args
		.split(/\s+/)
		.map((token) => token.trim())
		.filter((token) => token.length > 0);

	let zendeskId: number | null = null;
	let jiraKey: string | null = null;

	for (const token of tokens) {
		const jira = token.match(/^([A-Z][A-Z0-9]+-\d+)$/);
		if (jira) {
			jiraKey = jira[1] ?? null;
			continue;
		}

		const number = token.match(/^(\d{4,})$/);
		if (number) {
			zendeskId = Number(number[1]);
		}
	}

	const nextRefs: IssueRefs = {
		zendeskId: zendeskId ?? previous.zendeskId,
		jiraKey: jiraKey ?? previous.jiraKey,
	};

	const changed = nextRefs.zendeskId !== previous.zendeskId || nextRefs.jiraKey !== previous.jiraKey;
	return { refs: nextRefs, changed };
};

const truncateForModel = (text: string): string => {
	const truncated = truncateHead(text, {
		maxBytes: DEFAULT_MAX_BYTES,
		maxLines: DEFAULT_MAX_LINES,
	});
	if (!truncated.truncated) {
		return text;
	}
	return `${truncated.content}\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${truncated.outputBytes} of ${truncated.totalBytes} bytes)]`;
};

const extractZendeskComments = (rawComments: unknown): Array<TicketComment> => {
	const payload = rawComments as { comments?: Array<unknown> } | Array<unknown>;
	const list = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.comments)
			? payload.comments
			: [];

	return list
		.map((item) => {
			const comment = item as {
				author_id?: unknown;
				created_at?: unknown;
				public?: unknown;
				body?: unknown;
				plain_body?: unknown;
			};
			const body =
				coerceString(comment.body) ??
				coerceString(comment.plain_body) ??
				"";
			if (!body) {
				return null;
			}
			return {
				authorId: comment.author_id === undefined ? null : String(comment.author_id),
				createdAt: coerceString(comment.created_at),
				isPublic: typeof comment.public === "boolean" ? comment.public : null,
				body,
			} satisfies TicketComment;
		})
		.filter((entry): entry is TicketComment => entry !== null);
};

const extractZendeskContext = (
	zendeskId: number,
	rawTicket: unknown,
	rawComments: unknown,
): ZendeskContext => {
	const ticket = rawTicket as {
		id?: unknown;
		subject?: unknown;
		status?: unknown;
		priority?: unknown;
		description?: unknown;
		url?: unknown;
	};

	const ticketId = coerceNumber(ticket.id) ?? zendeskId;
	const ticketApiUrl = coerceString(ticket.url);

	return {
		id: ticketId,
		subject: coerceString(ticket.subject) ?? "(no subject)",
		status: coerceString(ticket.status),
		priority: coerceString(ticket.priority),
		url: toZendeskBrowserUrl(ticketApiUrl, ticketId),
		description: coerceString(ticket.description) ?? "",
		comments: extractZendeskComments(rawComments),
	};
};

const extractJiraComments = (rawIssue: unknown): Array<JiraComment> => {
	const issue = rawIssue as {
		fields?: {
			comment?: {
				comments?: Array<unknown>;
			};
		};
	};
	const comments = issue.fields?.comment?.comments;
	if (!Array.isArray(comments)) {
		return [];
	}

	return comments
		.map((item) => {
			const comment = item as {
				author?: { displayName?: unknown; name?: unknown };
				created?: unknown;
				body?: unknown;
			};
			const body = coerceString(comment.body) ?? "";
			if (!body) {
				return null;
			}
			const author = coerceString(comment.author?.displayName) ?? coerceString(comment.author?.name);
			return {
				author,
				createdAt: coerceString(comment.created),
				body,
			} satisfies JiraComment;
		})
		.filter((entry): entry is JiraComment => entry !== null);
};

const extractJiraContext = (jiraKey: string, rawIssue: unknown): JiraContext => {
	const issue = rawIssue as {
		key?: unknown;
		self?: unknown;
		fields?: {
			summary?: unknown;
			status?: { name?: unknown };
			assignee?: { displayName?: unknown; name?: unknown };
			description?: unknown;
		};
	};
	const issueKey = coerceString(issue.key) ?? jiraKey;
	const status = coerceString(issue.fields?.status?.name);
	const assignee = coerceString(issue.fields?.assignee?.displayName) ?? coerceString(issue.fields?.assignee?.name);
	const description = coerceString(issue.fields?.description) ?? "";
	const issueSelfUrl = coerceString(issue.self);

	return {
		key: issueKey,
		summary: coerceString(issue.fields?.summary) ?? "(no summary)",
		status,
		assignee,
		url: toJiraBrowserUrl(issueSelfUrl, issueKey),
		description,
		comments: extractJiraComments(rawIssue),
	};
};

type ViewerItem = {
	readonly id: string;
	readonly title: string;
	readonly lines: Array<string>;
};

type ViewerFocus = "items" | "detail";

const buildViewerItems = (context: CombinedContext): Array<ViewerItem> => {
	const items: Array<ViewerItem> = [];

	if (context.jira) {
		const issue = context.jira;
		items.push({
			id: `jira-${issue.key}`,
			title: `Jira ${issue.key}`,
			lines: [
				`Jira ${issue.key}`,
				`URL: ${issue.url ?? "(unavailable)"}`,
				`Summary: ${issue.summary}`,
				`Status: ${issue.status ?? "unknown"}`,
				`Assignee: ${issue.assignee ?? "unassigned"}`,
				"",
				"Description:",
				...(issue.description ? issue.description.split("\n") : ["(none)"]),
			],
		});

		for (const [index, comment] of issue.comments.entries()) {
			items.push({
				id: `jira-comment-${index + 1}`,
				title: `Jira comment #${index + 1}`,
				lines: [
					`Jira ${issue.key} comment #${index + 1}`,
					`Author: ${comment.author ?? "unknown"}`,
					`Created: ${comment.createdAt ?? "unknown"}`,
					"",
					...comment.body.split("\n"),
				],
			});
		}
	}

	if (context.zendesk) {
		const ticket = context.zendesk;
		items.push({
			id: `zendesk-${ticket.id}`,
			title: `Zendesk #${ticket.id}`,
			lines: [
				`Zendesk #${ticket.id}`,
				`URL: ${ticket.url ?? "(unavailable)"}`,
				`Subject: ${ticket.subject}`,
				`Status: ${ticket.status ?? "unknown"}`,
				`Priority: ${ticket.priority ?? "unknown"}`,
				"",
				"Description:",
				...(ticket.description ? ticket.description.split("\n") : ["(none)"]),
			],
		});

		for (const [index, comment] of ticket.comments.entries()) {
			const visibility = comment.isPublic === null ? "unknown" : comment.isPublic ? "public" : "private";
			items.push({
				id: `zendesk-comment-${index + 1}`,
				title: `Zendesk comment #${index + 1}`,
				lines: [
					`Zendesk #${ticket.id} comment #${index + 1}`,
					`Visibility: ${visibility}`,
					`Author ID: ${comment.authorId ?? "unknown"}`,
					`Created: ${comment.createdAt ?? "unknown"}`,
					"",
					...comment.body.split("\n"),
				],
			});
		}
	}

	if (items.length === 0) {
		items.push({
			id: "empty",
			title: "No data",
			lines: ["No issue data loaded yet."],
		});
	}

	return items;
};

const runScrollableViewer = async (pi: ExtensionAPI, ctx: ExtensionCommandContext, context: CombinedContext): Promise<void> => {
	const items = buildViewerItems(context);

	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		const container = new Container();
		const titleText = new Text("", 0, 0);
		const subtitleText = new Text("", 0, 0);
		const bodyText = new Text("", 0, 0);
		const footerText = new Text("", 0, 0);

		container.addChild(titleText);
		container.addChild(subtitleText);
		container.addChild(bodyText);
		container.addChild(footerText);

		let focus: ViewerFocus = "items";
		let selectedIndex = 0;
		let itemOffset = 0;
		let detailOffset = 0;
		let lastWidth = Number(process.stdout.columns) || 120;

		const getBodyRows = (): number => {
			const rows = Number(process.stdout.rows);
			if (Number.isFinite(rows) && rows > 10) {
				return Math.max(8, rows - 7);
			}
			return 20;
		};

		const selectedItem = (): ViewerItem => items[selectedIndex] ?? items[0]!;

		const openFromViewer = (target: "jira" | "zendesk"): void => {
			const url = target === "jira" ? context.jira?.url : context.zendesk?.url;
			if (!url) {
				ctx.ui.notify(`${target === "jira" ? "Jira" : "Zendesk"} URL is unavailable`, "warning");
				return;
			}

			ctx.ui.setStatus("nutrient-bug-open", ctx.ui.theme.fg("accent", `Opening ${target} URL...`));
			void openUrlInBrowser(pi, url)
				.then(() => {
					ctx.ui.notify(`Opened ${target} issue in browser`, "info");
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Failed to open ${target} URL: ${message}`, "error");
				})
				.finally(() => {
					ctx.ui.setStatus("nutrient-bug-open", undefined);
				});
		};

		const ensureSelectedVisible = (): void => {
			const bodyRows = getBodyRows();
			if (selectedIndex < itemOffset) {
				itemOffset = selectedIndex;
			}
			if (selectedIndex >= itemOffset + bodyRows) {
				itemOffset = selectedIndex - bodyRows + 1;
			}
		};

		const renderBody = (innerWidth: number): Array<string> => {
			const bodyRows = getBodyRows();
			const totalWidth = Math.max(36, innerWidth);
			const gap = " │ ";
			const leftWidth = Math.max(18, Math.min(36, Math.floor(totalWidth * 0.33)));
			const rightWidth = Math.max(12, totalWidth - leftWidth - gap.length);
			const rightLines = selectedItem().lines;
			const output: Array<string> = [];

			for (let row = 0; row < bodyRows; row += 1) {
				const leftIndex = itemOffset + row;
				const rightIndex = detailOffset + row;
				const isSelected = leftIndex === selectedIndex;
				const leftText = leftIndex < items.length
					? `${isSelected ? ">" : " "} ${items[leftIndex]?.title ?? ""}`
					: "";
				const rightText = rightIndex < rightLines.length ? (rightLines[rightIndex] ?? "") : "";

				const leftClamped = truncateToWidth(leftText, leftWidth, "…").padEnd(leftWidth, " ");
				const rightClamped = truncateToWidth(rightText, rightWidth, "…").padEnd(rightWidth, " ");
				output.push(`${leftClamped}${gap}${rightClamped}`);
			}

			return output;
		};

		const padToVisibleWidth = (text: string, width: number): string => {
			const missing = Math.max(0, width - visibleWidth(text));
			return `${text}${" ".repeat(missing)}`;
		};

		const frameLine = (innerText: string, innerWidth: number): string => {
			const clamped = truncateToWidth(innerText, innerWidth, "…");
			const padded = padToVisibleWidth(clamped, innerWidth);
			return theme.fg("accent", "│") + padded + theme.fg("accent", "│");
		};

		const refresh = (width: number): void => {
			lastWidth = width;
			const innerWidth = Math.max(36, width - 2);
			const frame: Array<string> = [];

			frame.push(theme.fg("accent", `┌${"─".repeat(innerWidth)}┐`));
			frame.push(frameLine(theme.fg("accent", theme.bold(`Nutrient issue viewer — ${summarizeRefs(context.refs)}`)), innerWidth));
			frame.push(frameLine(theme.fg("dim", `${focus === "items" ? "Focus: items" : "Focus: detail"} (Tab switches pane)`), innerWidth));
			frame.push(frameLine(theme.fg("dim", "Shortcuts: j open Jira • z open Zendesk"), innerWidth));
			frame.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));

			for (const line of renderBody(innerWidth)) {
				frame.push(frameLine(line, innerWidth));
			}

			const bodyRows = getBodyRows();
			const rightLines = selectedItem().lines;
			const endDetailLine = Math.min(detailOffset + bodyRows, rightLines.length);
			const footer = `Items ${selectedIndex + 1}/${items.length} | Detail lines ${detailOffset + 1}-${endDetailLine}/${Math.max(1, rightLines.length)} | ↑/↓ move/scroll | j open Jira | z open Zendesk | Enter/Esc close`;
			frame.push(theme.fg("accent", `├${"─".repeat(innerWidth)}┤`));
			frame.push(frameLine(theme.fg("dim", footer), innerWidth));
			frame.push(theme.fg("accent", `└${"─".repeat(innerWidth)}┘`));

			titleText.setText(frame.join("\n"));
			subtitleText.setText("");
			bodyText.setText("");
			footerText.setText("");
		};

		refresh(lastWidth);

		const consume = (): boolean => {
			tui.requestRender();
			return true;
		};

		return {
			render(width: number) {
				refresh(width);
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.tab)) {
					focus = focus === "items" ? "detail" : "items";
					return consume();
				}
				if (data.toLowerCase() === "j") {
					openFromViewer("jira");
					return consume();
				}
				if (data.toLowerCase() === "z") {
					openFromViewer("zendesk");
					return consume();
				}

				const bodyRows = getBodyRows();
				if (matchesKey(data, Key.down)) {
					if (focus === "items") {
						selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = Math.min(detailOffset + 1, Math.max(0, selectedItem().lines.length - bodyRows));
					}
					return consume();
				}
				if (matchesKey(data, Key.up)) {
					if (focus === "items") {
						selectedIndex = Math.max(selectedIndex - 1, 0);
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = Math.max(detailOffset - 1, 0);
					}
					return consume();
				}
				if (matchesKey(data, "pagedown")) {
					if (focus === "items") {
						selectedIndex = Math.min(selectedIndex + bodyRows, items.length - 1);
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = Math.min(detailOffset + bodyRows, Math.max(0, selectedItem().lines.length - bodyRows));
					}
					return consume();
				}
				if (matchesKey(data, "pageup")) {
					if (focus === "items") {
						selectedIndex = Math.max(selectedIndex - bodyRows, 0);
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = Math.max(detailOffset - bodyRows, 0);
					}
					return consume();
				}
				if (matchesKey(data, "home")) {
					if (focus === "items") {
						selectedIndex = 0;
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = 0;
					}
					return consume();
				}
				if (matchesKey(data, "end")) {
					if (focus === "items") {
						selectedIndex = items.length - 1;
						detailOffset = 0;
						ensureSelectedVisible();
					} else {
						detailOffset = Math.max(0, selectedItem().lines.length - bodyRows);
					}
					return consume();
				}
				if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape) || data.toLowerCase() === "q") {
					done();
					return true;
				}
				return false;
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "95%",
			maxHeight: "85%",
			margin: 1,
		},
	});
};

const fetchZendesk = async (
	pi: ExtensionAPI,
	zendeskId: number,
	refresh: boolean,
): Promise<ZendeskContext> => {
	const showArgs: Array<string> = ["ticket", "show", String(zendeskId), "-o", "json"];
	const commentsArgs: Array<string> = ["ticket", "comments", String(zendeskId), "-o", "json"];
	if (refresh) {
		showArgs.push("--refresh");
		commentsArgs.push("--refresh");
	}

	const ticketResult = await pi.exec("zd", showArgs);
	if (ticketResult.code !== 0) {
		const stderr = ticketResult.stderr.trim() || "zd ticket show failed";
		throw new Error(`failed to fetch zendesk ticket ${zendeskId}: ${stderr}`);
	}
	const commentsResult = await pi.exec("zd", commentsArgs);
	if (commentsResult.code !== 0) {
		const stderr = commentsResult.stderr.trim() || "zd ticket comments failed";
		throw new Error(`failed to fetch zendesk comments for ${zendeskId}: ${stderr}`);
	}

	const parsedTicket = parseJson(ticketResult.stdout);
	if (!parsedTicket.success) {
		throw new Error(parsedTicket.error);
	}
	const parsedComments = parseJson(commentsResult.stdout);
	if (!parsedComments.success) {
		throw new Error(parsedComments.error);
	}

	return extractZendeskContext(zendeskId, parsedTicket.json, parsedComments.json);
};

const fetchJira = async (pi: ExtensionAPI, jiraKey: string): Promise<JiraContext> => {
	const result = await pi.exec("jira", ["issue", "view", jiraKey, "--raw"]);
	if (result.code !== 0) {
		const stderr = result.stderr.trim() || "jira issue view failed";
		throw new Error(`failed to fetch jira issue ${jiraKey}: ${stderr}`);
	}
	const parsed = parseJson(result.stdout);
	if (!parsed.success) {
		throw new Error(parsed.error);
	}
	return extractJiraContext(jiraKey, parsed.json);
};

const fetchCombinedContext = async (
	pi: ExtensionAPI,
	refs: IssueRefs,
	refresh: boolean,
): Promise<CombinedContext> => {
	const zendesk = refs.zendeskId ? await fetchZendesk(pi, refs.zendeskId, refresh) : null;
	const jira = refs.jiraKey ? await fetchJira(pi, refs.jiraKey) : null;

	return {
		refs,
		zendesk,
		jira,
		fetchedAt: new Date().toISOString(),
	};
};

const toModelContextText = (context: CombinedContext): string => {
	return truncateForModel(JSON.stringify(context, null, 2));
};

export default function nutrientBugExtension(pi: ExtensionAPI): void {
	let state: IssueState = emptyState();

	const renderWidget = (ctx: ExtensionContext, refs: IssueRefs): void => {
		if (refs.zendeskId || refs.jiraKey) {
			ctx.ui.setWidget("nutrient-bug", [ctx.ui.theme.fg("accent", `Active issue: ${summarizeRefs(refs)}`)]);
		} else {
			ctx.ui.setWidget("nutrient-bug", undefined);
		}
	};

	const persistState = (nextState: IssueState, ctx: ExtensionContext): void => {
		state = nextState;
		pi.appendEntry(ISSUE_STATE_ENTRY, nextState);
		renderWidget(ctx, nextState.refs);
	};

	const updateRefs = (refs: IssueRefs, ctx: ExtensionContext): void => {
		const nextState: IssueState = {
			refs,
			context: state.context && state.context.refs.zendeskId === refs.zendeskId && state.context.refs.jiraKey === refs.jiraKey
				? state.context
				: null,
		};
		persistState(nextState, ctx);
	};

	const restoreState = (ctx: ExtensionContext): void => {
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i -= 1) {
			const entry = entries[i] as { type: string; customType?: string; data?: unknown };
			if (entry.type === "custom" && entry.customType === ISSUE_STATE_ENTRY) {
				const data = entry.data as IssueState | undefined;
				if (data?.refs) {
					state = data;
					renderWidget(ctx, state.refs);
					return;
				}
			}
		}
		state = emptyState();
		renderWidget(ctx, state.refs);
	};

	const loadContextIfNeeded = async (ctx: ExtensionContext, refresh: boolean): Promise<CombinedContext> => {
		if (!state.refs.zendeskId && !state.refs.jiraKey) {
			throw new Error("no active issue. use /bug <zendesk-id> <jira-key> first");
		}

		if (state.context && !refresh) {
			return state.context;
		}

		const context = await fetchCombinedContext(pi, state.refs, refresh);
		persistState({ refs: state.refs, context }, ctx);
		return context;
	};

	const promptBugSummary = (context: CombinedContext): void => {
		const refs = summarizeRefs(context.refs);
		pi.sendUserMessage(
			`Please call nutrient_bug_get_context (refresh: false) and summarize the active bug for the user (${refs}). Keep it concise and include: customer-reported issue, key timeline updates, current Jira/Zendesk status, and likely next technical step.`
		);
	};

	pi.registerTool({
		name: "nutrient_bug_get_context",
		label: "Nutrient Bug Context",
		description: "Fetch read-only context for the active nutrient bug from Zendesk and Jira.",
		parameters: Type.Object({
			refresh: Type.Optional(Type.Boolean({ default: false, description: "Refetch from APIs" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const context = await loadContextIfNeeded(ctx, params.refresh ?? false);
				const summary = summarizeRefs(context.refs);
				return {
					content: [{ type: "text", text: `${summary}\n\n${toModelContextText(context)}` }],
					details: context,
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: message }],
					isError: true,
				};
			}
		},
	});

	pi.registerCommand("bug", {
		description: "Set active nutrient issue refs. Usage: /bug <zendesk-id> <jira-key>",
		handler: async (args, ctx) => {
			const trimmed = (args ?? "").trim();
			if (!trimmed) {
				ctx.ui.notify(`Active issue: ${summarizeRefs(state.refs)}`, "info");
				return;
			}
			if (trimmed === "clear") {
				persistState(emptyState(), ctx);
				ctx.ui.notify("Cleared active issue", "info");
				return;
			}

			const parsed = parseBugCommandArgs(trimmed, state.refs);
			if (!parsed.changed) {
				ctx.ui.notify(`Issue unchanged: ${summarizeRefs(state.refs)}`, "info");
				return;
			}

			updateRefs(parsed.refs, ctx);
			ctx.ui.setStatus("nutrient-bug-fetch", ctx.ui.theme.fg("accent", "Fetching bug data and updating context..."));
			let context: CombinedContext;
			try {
				context = await loadContextIfNeeded(ctx, false);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Issue set, but context fetch failed: ${message}`, "warning");
				return;
			} finally {
				ctx.ui.setStatus("nutrient-bug-fetch", undefined);
			}
			ctx.ui.notify(`Active issue set: ${summarizeRefs(parsed.refs)} (context loaded)`, "info");
			promptBugSummary(context);
		},
	});


	pi.registerCommand("bug-view", {
		description: "Open a scrollable read-only viewer for the active nutrient issue",
		handler: async (_args, ctx) => {
			try {
				const context = await loadContextIfNeeded(ctx, false);
				if (!ctx.hasUI) {
					ctx.ui.notify("bug-view requires interactive UI", "warning");
					return;
				}
				await runScrollableViewer(pi, ctx, context);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand("bug-refresh", {
		description: "Refresh active nutrient issue context from Zendesk and Jira",
		handler: async (_args, ctx) => {
			ctx.ui.setStatus("nutrient-bug-fetch", ctx.ui.theme.fg("accent", "Refreshing bug data and updating context..."));
			try {
				await loadContextIfNeeded(ctx, true);
				ctx.ui.notify("Issue context refreshed", "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(message, "error");
			} finally {
				ctx.ui.setStatus("nutrient-bug-fetch", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		restoreState(ctx);
	});
}
