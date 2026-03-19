/**
 * Side-by-Side Diff Extension
 *
 * Overrides the built-in edit tool's renderResult to display diffs
 * in a side-by-side layout with syntax highlighting and
 * subtle background tints for added/removed lines.
 */

import {
	createEditTool,
	highlightCode,
	getLanguageFromPath,
	type EditToolDetails,
	type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

// ── ANSI helpers ──────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BG_GRAY = `\x1b[48;2;28;28;28m`;
const BG_REMOVED = `\x1b[48;2;55;22;28m`;
const BG_ADDED = `\x1b[48;2;22;50;32m`;

// ── Diff parsing ──────────────────────────────────────────────────

interface DiffLine {
	prefix: string;
	lineNum: string;
	content: string;
}

function parseDiffLine(line: string): DiffLine | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

interface SidePair {
	left: { lineNum: string; content: string; type: "removed" | "context" | "empty" };
	right: { lineNum: string; content: string; type: "added" | "context" | "empty" };
}

function buildSidePairs(diffText: string): SidePair[] {
	const lines = diffText.split("\n");
	const pairs: SidePair[] = [];
	let i = 0;

	while (i < lines.length) {
		const parsed = parseDiffLine(lines[i]);
		if (!parsed) { i++; continue; }

		if (parsed.prefix === " ") {
			pairs.push({
				left: { lineNum: parsed.lineNum, content: parsed.content, type: "context" },
				right: { lineNum: parsed.lineNum, content: parsed.content, type: "context" },
			});
			i++;
		} else if (parsed.prefix === "-") {
			const removed: DiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removed.push(p);
				i++;
			}
			const added: DiffLine[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				added.push(p);
				i++;
			}
			const maxLen = Math.max(removed.length, added.length);
			for (let j = 0; j < maxLen; j++) {
				const r = removed[j];
				const a = added[j];
				pairs.push({
					left: r
						? { lineNum: r.lineNum, content: r.content, type: "removed" }
						: { lineNum: "", content: "", type: "empty" },
					right: a
						? { lineNum: a.lineNum, content: a.content, type: "added" }
						: { lineNum: "", content: "", type: "empty" },
				});
			}
		} else if (parsed.prefix === "+") {
			pairs.push({
				left: { lineNum: "", content: "", type: "empty" },
				right: { lineNum: parsed.lineNum, content: parsed.content, type: "added" },
			});
			i++;
		} else {
			i++;
		}
	}

	return pairs;
}

// ── Highlight truncated lines ─────────────────────────────────────

function highlightLines(rawLines: string[], lang?: string): string[] {
	if (rawLines.length === 0) return [];
	const block = rawLines.join("\n");
	const result = highlightCode(block, lang);
	if (result.length === rawLines.length) return result;
	return rawLines;
}

// ── Side-by-side renderer ─────────────────────────────────────────

function renderSideBySide(diffText: string, theme: Theme, totalWidth: number, lang?: string): string {
	const pairs = buildSidePairs(diffText);
	if (pairs.length === 0) return theme.fg("muted", "  No changes");

	const dividerChar = `${BG_GRAY}\x1b[38;2;98;98;98m │ ${RESET}`;
	const sideWidth = Math.floor((totalWidth - 4) / 2);
	if (sideWidth < 10) return diffText;

	let maxNumWidth = 0;
	for (const pair of pairs) {
		maxNumWidth = Math.max(maxNumWidth, pair.left.lineNum.trim().length, pair.right.lineNum.trim().length);
	}
	const numWidth = Math.max(maxNumWidth, 1);
	const contentWidth = sideWidth - numWidth - 2;

	const allRawTrunc: string[] = [];
	const lineIndices: Array<{ pairIdx: number; side: "left" | "right" }> = [];

	for (let p = 0; p < pairs.length; p++) {
		for (const side of ["left", "right"] as const) {
			const s = pairs[p][side];
			if (s.type !== "empty") {
				const raw = s.content.replace(/\t/g, "   ");
				const trunc = raw.slice(0, contentWidth);
				allRawTrunc.push(trunc);
				lineIndices.push({ pairIdx: p, side });
			}
		}
	}

	const allHL = highlightLines(allRawTrunc, lang);

	const hlLookup = new Map<string, string>();
	for (let i = 0; i < lineIndices.length; i++) {
		const key = `${lineIndices[i].pairIdx}-${lineIndices[i].side}`;
		hlLookup.set(key, allHL[i]);
	}

	const output: string[] = [];

	for (let p = 0; p < pairs.length; p++) {
		const pair = pairs[p];

		function buildSide(side: typeof pair.left, sideKey: string, bgCode: string): string {
			if (side.type === "empty") {
				return `${bgCode}${" ".repeat(sideWidth)}${BG_GRAY}`;
			}

			const num = side.lineNum.trim().padStart(numWidth);
			const raw = side.content.replace(/\t/g, "   ");
			const trunc = raw.slice(0, contentWidth);
			const hl = hlLookup.get(sideKey) ?? trunc;
			let pad = " ".repeat(Math.max(0, contentWidth - trunc.length));

			return `${bgCode}\x1b[38;2;98;98;98m${num}${RESET}${bgCode} ${hl}${bgCode}${pad} `;
		}

		const leftBg = pair.left.type === "removed" ? BG_REMOVED : BG_GRAY;
		const rightBg = pair.right.type === "added" ? BG_ADDED : BG_GRAY;

		const leftSide = buildSide(pair.left, `${p}-left`, leftBg);
		const rightSide = buildSide(pair.right, `${p}-right`, rightBg);

		output.push(leftSide + dividerChar + rightSide);
	}

	return output.join("\n");
}

// ── Extension ─────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	const builtinEdit = createEditTool(process.cwd());

	pi.registerTool({
		name: "edit",
		label: "Edit",
		description: builtinEdit.description,
		parameters: builtinEdit.parameters,

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return builtinEdit.execute(toolCallId, params, signal, onUpdate, ctx);
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("edit "));
			text += theme.fg("muted", args.path || "");
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Editing…"), 0, 0);
			}

			const details = result.details as EditToolDetails | undefined;
			const content = result.content?.[0];
			const textContent = content && "text" in content ? content.text : "";

			if (!details?.diff) {
				return new Text(theme.fg("error", textContent || "No diff available"), 0, 0);
			}

			const pathMatch = textContent.match(/(?:Updated|edited)\s+(.+)/i);
			const filePath = pathMatch?.[1]?.trim();
			const lang = filePath ? getLanguageFromPath(filePath) : undefined;

			// Subtract 1 for minimal margin
			const width = (process.stdout.columns || 100) - 1;

			let text = renderSideBySide(details.diff, theme, width, lang);

			if (!expanded) {
				const lines = text.split("\n");
				if (lines.length > 14) {
					text = lines.slice(0, 14).join("\n");
					text += `\n${theme.fg("dim", `  … ${lines.length - 14} more lines (Ctrl+O to expand)`)}`;
				}
			}

			return new Text(text, 0, 0);
		},
	});
}
