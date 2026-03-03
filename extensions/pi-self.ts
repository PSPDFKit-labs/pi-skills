import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const MAX_OUTPUT_CHARS = 8000;

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n... (truncated ${text.length - limit} chars)`;
}

export default function piSelf(pi: ExtensionAPI) {
  pi.registerTool({
    name: "pi_run",
    label: "Pi Run",
    description: "Run a Pi CLI command as a subprocess (for tests or automation).",
    parameters: Type.Object({
      args: Type.Array(
        Type.String({ description: "Arguments passed to the pi CLI." })
      ),
      cwd: Type.Optional(
        Type.String({ description: "Working directory for the command." })
      ),
      timeoutMs: Type.Optional(
        Type.Number({ description: "Timeout in ms (default 120000)." })
      ),
    }),
    async execute(_toolCallId, params, signal) {
      const args = params.args ?? [];
      const cwd = params.cwd || process.cwd();
      const timeoutMs = params.timeoutMs ?? 120000;

      const result = await pi.exec("pi", args, { cwd, signal, timeout: timeoutMs });
      const stdout = result?.stdout ?? "";
      const stderr = result?.stderr ?? "";

      const output = [
        `exitCode: ${result?.exitCode ?? "unknown"}`,
        stdout ? `stdout:\n${truncate(stdout, MAX_OUTPUT_CHARS)}` : "stdout: (empty)",
        stderr ? `stderr:\n${truncate(stderr, MAX_OUTPUT_CHARS)}` : "stderr: (empty)",
      ].join("\n\n");

      return {
        content: [{ type: "text", text: output }],
        details: {
          exitCode: result?.exitCode ?? null,
          stdout,
          stderr,
        },
      };
    },
  });
}
