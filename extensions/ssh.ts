/**
 * SSH Remote Execution
 *
 * Demonstrates delegating tool operations to a remote machine via SSH.
 * When --ssh is provided, read/write/edit/bash run on the remote.
 *
 * Usage:
 *   pi -e ./ssh.ts --ssh user@host
 *   pi -e ./ssh.ts --ssh user@host:/remote/path
 *
 * Requirements:
 *   - SSH key-based auth (no password prompts)
 *   - bash on remote
 *
 * Docs: ~/.pi/agent/extensions/SSH.md
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@mariozechner/pi-coding-agent";

const SSH_OPTIONS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
const DEFAULT_LS_LIMIT = 500;
const DEFAULT_LS_MAX_BYTES = 50 * 1024;
const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

function getCliFlagValue(name: string): string | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) {
			const next = process.argv[i + 1];
			if (next && !next.startsWith("-")) {
				return next;
			}
		}
		if (arg.startsWith(prefix)) {
			return arg.slice(prefix.length);
		}
	}
	return undefined;
}

function getCliFlagBoolean(name: string): boolean | undefined {
	const longName = `--${name}`;
	const prefix = `${longName}=`;
	for (let i = 0; i < process.argv.length; i += 1) {
		const arg = process.argv[i];
		if (arg === longName) return true;
		if (arg.startsWith(prefix)) {
			const value = arg.slice(prefix.length).toLowerCase();
			if (value === "true") return true;
			if (value === "false") return false;
		}
	}
	return undefined;
}

function truncateToBytes(input: string, maxBytes: number): { text: string; truncated: boolean } {
	const buf = Buffer.from(input, "utf-8");
	if (buf.length <= maxBytes) {
		return { text: input, truncated: false };
	}
	let end = maxBytes;
	while (end > 0 && (buf[end] & 0xc0) === 0x80) {
		end -= 1;
	}
	return { text: buf.slice(0, end).toString("utf-8"), truncated: true };
}

function truncateLine(line: string, maxChars = GREP_MAX_LINE_LENGTH): { text: string; wasTruncated: boolean } {
	if (line.length <= maxChars) {
		return { text: line, wasTruncated: false };
	}
	return { text: `${line.slice(0, maxChars)}... [truncated]`, wasTruncated: true };
}

function sshExec(remote: string, command: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("ssh", [...SSH_OPTIONS, remote, command], { stdio: ["ignore", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (data) => chunks.push(data));
		child.stderr.on("data", (data) => errChunks.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`SSH failed (${code}): ${Buffer.concat(errChunks).toString()}`));
			} else {
				resolve(Buffer.concat(chunks));
			}
		});
	});
}

function parseSshArg(arg: string): { remote: string; remoteCwd?: string } {
	const match = arg.match(/^(.+?):(\/.*)$/);
	if (match) {
		return { remote: match[1], remoteCwd: match[2] };
	}
	return { remote: arg };
}

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	return {
		readFile: (p) => sshExec(remote, `cat ${JSON.stringify(toRemote(p))}`),
		access: (p) => sshExec(remote, `test -r ${JSON.stringify(toRemote(p))}`).then(() => {}),
		detectImageMimeType: async (p) => {
			try {
				const r = await sshExec(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.toString().trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(remote: string, remoteCwd: string, localCwd: string): WriteOperations {
	const toRemote = (p: string) => resolveRemotePath(remoteCwd, localCwd, p);
	return {
		writeFile: async (p, content) => {
			const b64 = Buffer.from(content).toString("base64");
			await sshExec(remote, `echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(toRemote(p))}`);
		},
		mkdir: (dir) => sshExec(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`).then(() => {}),
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(remote: string, remoteCwd: string, localCwd: string): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				const cmd = `cd ${JSON.stringify(toRemote(cwd))} && ${command}`;
				const child = spawn("ssh", [...SSH_OPTIONS, remote, cmd], { stdio: ["ignore", "pipe", "pipe"] });
				let timedOut = false;
				const timer = timeout
					? setTimeout(() => {
							timedOut = true;
							child.kill();
						}, timeout * 1000)
					: undefined;
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", (e) => {
					if (timer) clearTimeout(timer);
					reject(e);
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					if (timer) clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timedOut) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};
}

function resolveRemotePath(remoteCwd: string, localCwd: string, path: string | undefined): string {
	const rawPath = path ?? ".";
	if (rawPath.startsWith(localCwd)) {
		return rawPath.replace(localCwd, remoteCwd);
	}
	if (rawPath.startsWith("/")) return rawPath;
	return `${remoteCwd}/${rawPath}`;
}

async function remoteLs(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	path: string | undefined,
	limit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const resolvedPath = resolveRemotePath(remoteCwd, localCwd, path);
	try {
		await sshExec(remote, `test -e ${JSON.stringify(resolvedPath)}`);
	} catch {
		throw new Error(`Path not found: ${resolvedPath}`);
	}
	try {
		await sshExec(remote, `test -d ${JSON.stringify(resolvedPath)}`);
	} catch {
		throw new Error(`Not a directory: ${resolvedPath}`);
	}
	const rawEntries = (await sshExec(remote, `LC_ALL=C ls -A -p ${JSON.stringify(resolvedPath)}`))
		.toString()
		.trim();
	const entries = rawEntries.length ? rawEntries.split("\n") : [];
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const effectiveLimit = limit ?? DEFAULT_LS_LIMIT;
	let entryLimitReached = false;
	let limitedEntries = entries;
	if (entries.length > effectiveLimit) {
		entryLimitReached = true;
		limitedEntries = entries.slice(0, effectiveLimit);
	}
	let output = limitedEntries.length ? limitedEntries.join("\n") : "(empty directory)";
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (entryLimitReached) {
		notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		details.entryLimitReached = effectiveLimit;
	}
	if (Buffer.byteLength(output, "utf-8") > DEFAULT_LS_MAX_BYTES) {
		output = output.slice(0, DEFAULT_LS_MAX_BYTES);
		notices.push(`${DEFAULT_LS_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

async function ensureRemoteCommand(remote: string, command: string): Promise<void> {
	try {
		await sshExec(remote, `command -v ${command}`);
	} catch {
		throw new Error(`${command} is not available on the remote host`);
	}
}

function joinRemotePath(base: string, childPath: string): string {
	if (childPath.startsWith("/")) return childPath;
	return path.posix.join(base, childPath);
}

async function remoteFind(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	pattern: string,
	searchDir: string | undefined,
	limit: number | undefined,
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const searchPath = resolveRemotePath(remoteCwd, localCwd, searchDir);
	try {
		await sshExec(remote, `test -e ${JSON.stringify(searchPath)}`);
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
	try {
		await sshExec(remote, `test -d ${JSON.stringify(searchPath)}`);
	} catch {
		throw new Error(`Not a directory: ${searchPath}`);
	}
	await ensureRemoteCommand(remote, "rg");
	const rgCmd = `cd ${JSON.stringify(searchPath)} && rg --files --hidden -g ${JSON.stringify(pattern)}`;
	const wrappedCmd = `bash -lc ${JSON.stringify(`${rgCmd}; code=$?; if [ $code -eq 1 ]; then exit 0; else exit $code; fi`)}`;
	const rawOutput = (await sshExec(remote, wrappedCmd)).toString().trim();
	if (!rawOutput) {
		return { content: [{ type: "text", text: "No files found matching pattern" }] };
	}
	const entries = rawOutput.split("\n").filter((line) => line.trim().length > 0);
	entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
	const effectiveLimit = limit ?? DEFAULT_FIND_LIMIT;
	const resultLimitReached = entries.length >= effectiveLimit;
	const limitedEntries = entries.slice(0, effectiveLimit);
	let output = limitedEntries.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (resultLimitReached) {
		notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.resultLimitReached = effectiveLimit;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

async function remoteGrep(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	params: {
		pattern: string;
		path?: string;
		glob?: string;
		ignoreCase?: boolean;
		literal?: boolean;
		context?: number;
		limit?: number;
	},
): Promise<{ content: Array<{ type: "text"; text: string }>; details?: Record<string, unknown> }> {
	const searchPath = resolveRemotePath(remoteCwd, localCwd, params.path);
	let isDirectory = false;
	try {
		await sshExec(remote, `test -d ${JSON.stringify(searchPath)}`);
		isDirectory = true;
	} catch {
		try {
			await sshExec(remote, `test -e ${JSON.stringify(searchPath)}`);
		} catch {
			throw new Error(`Path not found: ${searchPath}`);
		}
	}
	await ensureRemoteCommand(remote, "rg");
	const args: string[] = ["rg", "--json", "--line-number", "--color=never", "--hidden"];
	if (params.ignoreCase) args.push("--ignore-case");
	if (params.literal) args.push("--fixed-strings");
	if (params.glob) {
		args.push("--glob", params.glob);
	}
	args.push(params.pattern, searchPath);
	const rgCmd = args.map((arg) => JSON.stringify(arg)).join(" ");
	const wrappedCmd = `bash -lc ${JSON.stringify(`${rgCmd}; code=$?; if [ $code -eq 1 ]; then exit 0; else exit $code; fi`)}`;
	const rawOutput = (await sshExec(remote, wrappedCmd)).toString();
	const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
	const contextValue = params.context && params.context > 0 ? params.context : 0;
	const matches: Array<{ filePath: string; lineNumber: number }> = [];
	let matchLimitReached = false;
	for (const line of rawOutput.split("\n")) {
		if (!line.trim()) continue;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (event.type === "match") {
			const filePath = event.data?.path?.text;
			const lineNumber = event.data?.line_number;
			if (filePath && typeof lineNumber === "number") {
				if (matches.length < effectiveLimit) {
					matches.push({ filePath, lineNumber });
				} else {
					matchLimitReached = true;
				}
			}
		}
	}
	if (matches.length === 0) {
		return { content: [{ type: "text", text: "No matches found" }] };
	}
	const formatPath = (filePath: string) => {
		if (isDirectory) {
			const relative = path.posix.relative(searchPath, filePath);
			if (relative && !relative.startsWith("..")) {
				return relative;
			}
		}
		return path.posix.basename(filePath);
	};
	const fileCache = new Map<string, string[]>();
	const getFileLines = async (filePath: string) => {
		let lines = fileCache.get(filePath);
		if (!lines) {
			try {
				const content = (await sshExec(remote, `cat ${JSON.stringify(filePath)}`)).toString("utf-8");
				lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
			} catch {
				lines = [];
			}
			fileCache.set(filePath, lines);
		}
		return lines;
	};
	const outputLines: string[] = [];
	let linesTruncated = false;
	for (const match of matches) {
		const absolutePath = joinRemotePath(isDirectory ? searchPath : path.posix.dirname(searchPath), match.filePath);
		const relativePath = formatPath(absolutePath);
		const lines = await getFileLines(absolutePath);
		if (!lines.length) {
			outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
			continue;
		}
		const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
		const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
		for (let current = start; current <= end; current += 1) {
			const lineText = lines[current - 1] ?? "";
			const sanitized = lineText.replace(/\r/g, "");
			const { text: truncatedText, wasTruncated } = truncateLine(sanitized, GREP_MAX_LINE_LENGTH);
			if (wasTruncated) linesTruncated = true;
			if (current === match.lineNumber) {
				outputLines.push(`${relativePath}:${current}: ${truncatedText}`);
			} else {
				outputLines.push(`${relativePath}-${current}- ${truncatedText}`);
			}
		}
	}
	let output = outputLines.join("\n");
	const details: Record<string, unknown> = {};
	const notices: string[] = [];
	if (matchLimitReached) {
		notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
		details.matchLimitReached = effectiveLimit;
	}
	const truncation = truncateToBytes(output, DEFAULT_MAX_BYTES);
	if (truncation.truncated) {
		output = truncation.text;
		notices.push(`${DEFAULT_MAX_BYTES / 1024}KB limit reached`);
		details.truncation = { truncated: true };
	}
	if (linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	if (notices.length > 0) {
		output += `\n\n[${notices.join(". ")}]`;
	}
	return { content: [{ type: "text", text: output }], details: Object.keys(details).length ? details : undefined };
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("ssh", { description: "SSH remote: user@host or user@host:/path", type: "string" });
	pi.registerFlag("ssh-debug", { description: "Enable SSH debug status output", type: "boolean" });
	pi.registerFlag("ssh-verify", {
		description: "Verify a remote path exists and list it on connect",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localFind = createFindTool(localCwd);
	const localGrep = createGrepTool(localCwd);
	const localLs = createLsTool(localCwd);
	const localBash = createBashTool(localCwd);

	// Resolved lazily on session_start (CLI flags not available during factory)
	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	let sshRequired = false;
	let sshDebug = false;
	let sshError: Error | null = null;
	let remoteHost: string | null = null;
	let remoteAgentsContent: string | null = null;

	const getSsh = () => resolvedSsh;
	const requireSsh = () => {
		if (!resolvedSsh && sshRequired) {
			const details = sshError ? ` (${sshError.message})` : "";
			throw new Error(`SSH mode was requested but is not available${details}.`);
		}
		return resolvedSsh;
	};
	const mapRemotePath = (ssh: { remoteCwd: string }, p: string) => p.replace(localCwd, ssh.remoteCwd);
	const setDebugStatus = (ctx: any, message: string) => {
		if (!sshDebug) return;
		ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("accent", message));
	};

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} read: ${targetPath}`);
			}
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} write: ${targetPath}`);
			}
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const path = (params as { path: string }).path;
				const targetPath = ssh ? mapRemotePath(ssh, path) : path;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} edit: ${targetPath}`);
			}
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localFind,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { pattern, path: searchPath, limit } = params as {
				pattern: string;
				path?: string;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, searchPath) : searchPath ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} find: ${targetPath} :: ${pattern}`);
			}
			if (ssh) {
				return remoteFind(ssh.remote, ssh.remoteCwd, localCwd, pattern, searchPath, limit);
			}
			return localFind.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localGrep,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const typed = params as {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			};
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, typed.path) : typed.path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} grep: ${targetPath} :: ${typed.pattern}`);
			}
			if (ssh) {
				return remoteGrep(ssh.remote, ssh.remoteCwd, localCwd, typed);
			}
			return localGrep.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localLs,
		async execute(id, params, _signal, _onUpdate, ctx) {
			const ssh = requireSsh();
			const { path, limit } = params as { path?: string; limit?: number };
			if (sshDebug && ctx) {
				const targetPath = ssh ? resolveRemotePath(ssh.remoteCwd, localCwd, path) : path ?? ".";
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} ls: ${targetPath}`);
			}
			if (ssh) {
				return remoteLs(ssh.remote, ssh.remoteCwd, localCwd, path, limit);
			}
			return localLs.execute(id, params, _signal, _onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = requireSsh();
			if (sshDebug && ctx) {
				const { command, cwd } = params as { command: string; cwd: string };
				const targetCwd = ssh ? mapRemotePath(ssh, cwd) : cwd;
				setDebugStatus(ctx, `SSH ${ssh ? "remote" : "local"} bash: ${targetCwd} :: ${command}`);
			}
			if (ssh) {
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		// Resolve SSH config now that CLI flags are available
		const arg = (pi.getFlag("ssh") as string | undefined) ?? getCliFlagValue("ssh");
		sshRequired = Boolean(arg);
		const cliDebug = getCliFlagBoolean("ssh-debug");
		sshDebug = Boolean((pi.getFlag("ssh-debug") as boolean | undefined) ?? cliDebug);
		const sshVerify = (pi.getFlag("ssh-verify") as string | undefined) ?? getCliFlagValue("ssh-verify");
		if (arg) {
			try {
				const parsed = parseSshArg(arg);
				const remote = parsed.remote;
				const remoteCwd = parsed.remoteCwd ?? (await sshExec(remote, "pwd")).toString().trim();
				await sshExec(remote, `test -d ${JSON.stringify(remoteCwd)}`);
				if (sshVerify) {
					await sshExec(remote, `test -d ${JSON.stringify(sshVerify)}`);
					const listing = (await sshExec(remote, `ls -a ${JSON.stringify(sshVerify)}`)).toString().trim();
					ctx.ui.notify(
						`SSH verify: ${sshVerify}\n${listing || "(empty directory)"}`,
						"info",
					);
				}
				resolvedSsh = { remote, remoteCwd };
				sshError = null;
				remoteAgentsContent = null;
				try {
					await sshExec(remote, `test -r ${JSON.stringify(`${remoteCwd}/AGENTS.md`)}`);
					remoteAgentsContent = (await sshExec(remote, `cat ${JSON.stringify(`${remoteCwd}/AGENTS.md`)}`)).toString("utf-8");
					if (remoteAgentsContent.trim().length === 0) {
						remoteAgentsContent = null;
					}
				} catch {
					remoteAgentsContent = null;
				}
				if (sshDebug) {
					remoteHost = (await sshExec(remote, "hostname")).toString().trim();
					ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("accent", `SSH debug: ${remoteHost}`));
					ctx.ui.notify(`SSH debug: connected to ${remoteHost} (${resolvedSsh.remote}:${resolvedSsh.remoteCwd})`, "info");
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`));
				ctx.ui.notify(`SSH mode: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`, "info");
			} catch (error) {
				sshError = error instanceof Error ? error : new Error(String(error));
				if (sshDebug) {
					ctx.ui.setStatus("ssh-debug", ctx.ui.theme.fg("error", "SSH debug: failed"));
				}
				ctx.ui.setStatus("ssh", ctx.ui.theme.fg("error", "SSH: failed"));
				ctx.ui.notify(`SSH requested but failed: ${sshError.message}`, "error");
			}
		}
	});

	// Handle user ! commands via SSH
	pi.on("user_bash", (_event) => {
		const ssh = requireSsh();
		if (!ssh) return; // No SSH, use local execution
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd) };
	});

	pi.on("context", async (event) => {
		if (!remoteAgentsContent) return;
		const marker = "[Remote AGENTS.md]";
		const alreadyInjected = event.messages.some((message) => {
			if (message.role !== "user" || !Array.isArray(message.content)) return false;
			return message.content.some((item) => item.type === "text" && item.text?.includes(marker));
		});
		if (alreadyInjected) return;
		const injected = {
			role: "user" as const,
			content: [{ type: "text" as const, text: `${marker}\n${remoteAgentsContent}` }],
			timestamp: Date.now(),
		};
		return { messages: [injected, ...event.messages] };
	});

	// Replace local cwd with remote cwd in system prompt
	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		let modified = event.systemPrompt;
		if (ssh) {
			modified = modified.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
		}
		if (sshDebug) {
			if (ssh) {
				const hostInfo = remoteHost ?? "unknown";
				modified += `\nSSH debug: remote=${ssh.remote} host=${hostInfo} cwd=${ssh.remoteCwd} localCwd=${localCwd}`;
			} else if (sshRequired) {
				modified += "\nSSH debug: requested but not connected";
			} else {
				modified += "\nSSH debug: not requested";
			}
		}
		if (modified !== event.systemPrompt) {
			return { systemPrompt: modified };
		}
	});
}
