import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve } from "node:path";
import { homedir } from "node:os";

export default function (pi: ExtensionAPI) {
  const repoDir = resolve(
    homedir(),
    ".pi/agent/git/github.com/PSPDFKit-labs/pi-skills"
  );

  pi.on("session_start", async (_event, ctx) => {
    try {
      // Get local HEAD
      const local = await pi.exec("git", ["-C", repoDir, "rev-parse", "HEAD"], {
        timeout: 5000,
      });
      if (local.code !== 0) return;
      const localHead = local.stdout.trim();

      // Check remote HEAD (lightweight, no fetch/clone)
      const remote = await pi.exec(
        "git",
        ["ls-remote", "https://github.com/PSPDFKit-labs/pi-skills.git", "HEAD"],
        { timeout: 10000 }
      );
      if (remote.code !== 0) return;
      const remoteHead = remote.stdout.split(/\s/)[0]?.trim();

      if (!remoteHead || localHead === remoteHead) return;

      // There are updates — fetch to get commit details
      await pi.exec("git", ["-C", repoDir, "fetch", "origin", "main"], {
        timeout: 10000,
      });

      const log = await pi.exec(
        "git",
        [
          "-C", repoDir,
          "log",
          "--oneline",
          "--no-decorate",
          `${localHead}..origin/main`,
        ],
        { timeout: 5000 }
      );

      const commits = log.code === 0 ? log.stdout.trim() : "";
      const count = commits ? commits.split("\n").length : "?";

      const message = [
        `🔔 **pi-skills has ${count} new update${count === 1 ? "" : "s"}:**`,
        "",
        "```",
        commits,
        "```",
        "",
        'Run `pi update` and then `/reload` to apply.',
      ].join("\n");

      pi.sendMessage({
        customType: "pi-skills-update-checker",
        content: message,
        display: true,
      });
    } catch {
      // Silently ignore — don't nag on network errors
    }
  });
}
