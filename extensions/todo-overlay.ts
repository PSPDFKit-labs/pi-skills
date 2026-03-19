/**
 * TODO Overlay
 *
 * Shows TODO.md from the current cwd in a right-side non-capturing overlay.
 * - Auto-shows when TODO.md exists
 * - Toggle with Ctrl+T
 * - Refreshes after each agent response (agent_end)
 */

import fs from "node:fs";
import path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext, type Theme } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, visibleWidth, type Component, type OverlayHandle, type TUI } from "@mariozechner/pi-tui";

function renderTaskMarkers(text: string, theme: Theme): string {
	return text
		.replace(/^([ \t]*[-*][ \t]+)\[ \][ \t]+/gm, "[ ] ")
		.replace(/^([ \t]*[-*][ \t]+)\[[xX]\][ \t]+/gm, () => {
			return `${theme.fg("mdHeading", theme.bold("[x]"))} `;
		});
}

class TodoOverlayComponent implements Component {
	private markdown: Markdown;
	private box: Box;
	private title = "TODO.md";
	private theme: Theme;
	private scrollOffset = 0;

	constructor(theme: Theme) {
		this.theme = theme;
		this.markdown = new Markdown("", 0, 0, getMarkdownTheme(), {
			color: (s) => theme.fg("text", s),
		});
		this.box = new Box(2, 1);
		this.box.addChild(this.markdown);
	}

	setContent(title: string, body: string) {
		this.title = title;
		const rendered = body ? renderTaskMarkers(body, this.theme) : this.theme.fg("dim", "(empty)");
		this.markdown.setText(rendered);
	}

	scrollBy(delta: number) {
		this.scrollOffset = Math.max(0, this.scrollOffset + delta);
	}

	render(width: number): string[] {
		const innerWidth = Math.max(1, width - 2);
		const title = ` ${this.title} `;
		const bodyLinesAll = this.box.render(innerWidth);

		const visibleBodyCapacity = Math.max(1, Math.floor(process.stdout.rows * 0.6) - 2);
		const maxOffset = Math.max(0, bodyLinesAll.length - visibleBodyCapacity);
		if (this.scrollOffset > maxOffset) this.scrollOffset = maxOffset;
		const bodyLinesVisible = bodyLinesAll.slice(this.scrollOffset, this.scrollOffset + visibleBodyCapacity);

		let headerText = title;
		if (maxOffset > 0) {
			headerText = ` ${this.title} (${this.scrollOffset + 1}-${Math.min(this.scrollOffset + bodyLinesVisible.length, bodyLinesAll.length)}/${bodyLinesAll.length}) `;
		}
		const headerWidth = visibleWidth(headerText);
		const top = this.theme.fg("borderMuted", `╭${headerText}${"─".repeat(Math.max(0, innerWidth - headerWidth))}╮`);
		const bottom = this.theme.fg("borderMuted", `╰${"─".repeat(innerWidth)}╯`);
		const bodyLines = bodyLinesVisible.map((line) => {
			const pad = Math.max(0, innerWidth - visibleWidth(line));
			return this.theme.fg("borderMuted", "│") + line + " ".repeat(pad) + this.theme.fg("borderMuted", "│");
		});
		return [top, ...bodyLines, bottom];
	}

	invalidate(): void {
		this.markdown.invalidate();
		this.box.invalidate();
	}
}

export default function todoOverlay(pi: ExtensionAPI) {
	let handle: OverlayHandle | null = null;
	let tuiRef: TUI | null = null;
	let component: TodoOverlayComponent | null = null;
	let hiddenByUser = false;
	let currentCtx: ExtensionContext | null = null;
	let watcher: fs.FSWatcher | null = null;
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;

	function getTodoPath(cwd: string): string | null {
		const candidates = ["TODO.md", "todo.md"];
		for (const name of candidates) {
			const p = path.join(cwd, name);
			if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
		}
		return null;
	}

	function readTodo(cwd: string): { path: string; body: string } | null {
		const todoPath = getTodoPath(cwd);
		if (!todoPath) return null;
		try {
			return { path: todoPath, body: fs.readFileSync(todoPath, "utf8") };
		} catch {
			return { path: todoPath, body: "(failed to read TODO.md)" };
		}
	}

	function ensureOverlay(ctx: ExtensionContext) {
		currentCtx = ctx;
		const todo = readTodo(ctx.cwd);
		if (!todo) {
			if (handle) handle.setHidden(true);
			return;
		}

		if (!component) {
			// Create overlay once; keep it around and update content.
			void ctx.ui.custom<void>((tui, theme, _kb, _done) => {
				tuiRef = tui;
				component = new TodoOverlayComponent(theme);
				component.setContent(path.basename(todo.path), todo.body);
				return component;
			}, {
				overlay: true,
				overlayOptions: {
					anchor: "right-center",
					width: "28%",
					minWidth: 28,
					maxHeight: "60%",
					margin: { right: 1, top: 1, bottom: 1 },
					visible: (termWidth) => termWidth >= 100,
					nonCapturing: true,
				},
				onHandle: (h) => {
					handle = h;
					if (hiddenByUser) handle.setHidden(true);
				},
			});
			return;
		}

		component.setContent(path.basename(todo.path), todo.body);
		if (handle && !hiddenByUser) handle.setHidden(false);
		tuiRef?.requestRender();
	}

	function refreshOverlay() {
		if (!currentCtx) return;
		const todo = readTodo(currentCtx.cwd);
		if (!todo) {
			if (handle) handle.setHidden(true);
			return;
		}
		if (!component) {
			ensureOverlay(currentCtx);
			return;
		}
		component.setContent(path.basename(todo.path), todo.body);
		if (handle && !hiddenByUser) handle.setHidden(false);
		tuiRef?.requestRender();
	}

	function scheduleRefresh() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refreshOverlay();
		}, 50);
	}

	function stopWatcher() {
		if (watcher) {
			watcher.close();
			watcher = null;
		}
		if (refreshTimer) {
			clearTimeout(refreshTimer);
			refreshTimer = null;
		}
	}

	function startWatcher(ctx: ExtensionContext) {
		stopWatcher();
		try {
			watcher = fs.watch(ctx.cwd, (_eventType, filename) => {
				if (!filename) {
					scheduleRefresh();
					return;
				}
				const name = filename.toString();
				if (name === "TODO.md" || name === "todo.md") {
					scheduleRefresh();
				}
			});
		} catch {
			// Ignore watch errors; lifecycle refresh still works.
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		hiddenByUser = false;
		ensureOverlay(ctx);
		startWatcher(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		hiddenByUser = false;
		ensureOverlay(ctx);
		startWatcher(ctx);
	});

	pi.on("agent_end", async (_event, _ctx) => {
		refreshOverlay();
	});

	pi.registerShortcut("alt+t", {
		description: "Toggle TODO overlay",
		handler: async (ctx) => {
			currentCtx = ctx;
			const todo = readTodo(ctx.cwd);
			if (!todo) {
				ctx.ui.notify("No TODO.md in current directory", "info");
				return;
			}

			if (!component || !handle) {
				hiddenByUser = false;
				ensureOverlay(ctx);
				ctx.ui.notify("TODO overlay shown", "info");
				return;
			}

			hiddenByUser = !hiddenByUser;
			handle.setHidden(hiddenByUser);
			tuiRef?.requestRender();
			ctx.ui.notify(hiddenByUser ? "TODO overlay hidden" : "TODO overlay shown", "info");
		},
	});

	pi.registerShortcut("ctrl+shift+k", {
		description: "Scroll TODO overlay up",
		handler: async (_ctx) => {
			if (!component || hiddenByUser) return;
			component.scrollBy(-5);
			tuiRef?.requestRender();
		},
	});

	pi.registerShortcut("ctrl+shift+j", {
		description: "Scroll TODO overlay down",
		handler: async (_ctx) => {
			if (!component || hiddenByUser) return;
			component.scrollBy(5);
			tuiRef?.requestRender();
		},
	});

	pi.on("session_shutdown", async () => {
		stopWatcher();
		if (handle) handle.hide();
		handle = null;
		component = null;
		tuiRef = null;
		currentCtx = null;
	});
}
