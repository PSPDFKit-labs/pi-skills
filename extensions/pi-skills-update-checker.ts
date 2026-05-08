import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type EventType = "update_available" | "still_pending" | "no_updates" | "updated" | "check_failed";

type UpdateEvent = {
  at: string;
  type: EventType;
  details?: string;
};

type PendingUpdate = {
  localHead: string;
  remoteHead: string;
  commits: string;
  message: string;
  detectedAt: string;
};

type CheckerState = {
  version: 1;
  lastCheckedDay?: string;
  pending?: PendingUpdate;
  events?: UpdateEvent[];
};

const repoDir = resolve(homedir(), ".pi/agent/git/github.com/PSPDFKit-labs/pi-skills");
const statePath = resolve(homedir(), ".pi/agent/extensions/pi-skills-update-checker/state.json");

const todayKey = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const loadState = (): CheckerState => {
  try {
    if (!existsSync(statePath)) {
      return { version: 1, events: [] };
    }

    const raw = JSON.parse(readFileSync(statePath, "utf8")) as CheckerState;
    return {
      version: 1,
      lastCheckedDay: raw.lastCheckedDay,
      pending: raw.pending,
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  } catch {
    return { version: 1, events: [] };
  }
};

const saveState = (state: CheckerState): void => {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // non-fatal
  }
};

const addEvent = (state: CheckerState, type: EventType, details?: string): void => {
  const next: UpdateEvent[] = [...(state.events ?? []), { at: new Date().toISOString(), type, details }];
  state.events = next.slice(-100);
};

const buildMessage = (count: number | string, commits: string): string => {
  return [
    `🔔 **pi-skills has ${count} new update${count === 1 ? "" : "s"}:**`,
    "",
    "```",
    commits,
    "```",
    "",
    "Run `pi update` and then `/reload` to apply.",
  ].join("\n");
};

const sendPendingMessage = (pi: ExtensionAPI, state: CheckerState): void => {
  if (!state.pending?.message) return;
  pi.sendMessage({
    customType: "pi-skills-update-checker",
    content: state.pending.message,
    display: true,
  });
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async () => {
    const state = loadState();
    const today = todayKey();

    try {
      const local = await pi.exec("git", ["-C", repoDir, "rev-parse", "HEAD"], {
        timeout: 5000,
      });
      if (local.code !== 0) return;

      const localHead = local.stdout.trim();

      // If local now equals previously detected remote head, user has updated.
      if (state.pending && state.pending.remoteHead === localHead) {
        addEvent(state, "updated", `local head reached ${localHead.slice(0, 12)}`);
        delete state.pending;
        saveState(state);
      }

      // Already checked today: do not re-run network checks.
      if (state.lastCheckedDay === today) {
        sendPendingMessage(pi, state);
        return;
      }

      // Daily check.
      const remote = await pi.exec(
        "git",
        ["ls-remote", "https://github.com/PSPDFKit-labs/pi-skills.git", "HEAD"],
        { timeout: 10000 },
      );

      if (remote.code !== 0) {
        state.lastCheckedDay = today;
        addEvent(state, "check_failed", "git ls-remote failed");
        saveState(state);
        sendPendingMessage(pi, state);
        return;
      }

      const remoteHead = remote.stdout.split(/\s/)[0]?.trim();
      if (!remoteHead) {
        state.lastCheckedDay = today;
        addEvent(state, "check_failed", "remote HEAD not found");
        saveState(state);
        sendPendingMessage(pi, state);
        return;
      }

      if (localHead === remoteHead) {
        state.lastCheckedDay = today;
        if (state.pending) {
          addEvent(state, "updated", `local=${localHead.slice(0, 12)} remote=${remoteHead.slice(0, 12)}`);
        } else {
          addEvent(state, "no_updates", `head=${localHead.slice(0, 12)}`);
        }
        delete state.pending;
        saveState(state);
        return;
      }

      // Same pending update as before; keep and re-display the same message.
      if (state.pending && state.pending.localHead === localHead && state.pending.remoteHead === remoteHead) {
        state.lastCheckedDay = today;
        addEvent(state, "still_pending", `${localHead.slice(0, 12)}..${remoteHead.slice(0, 12)}`);
        saveState(state);
        sendPendingMessage(pi, state);
        return;
      }

      // New pending update details.
      await pi.exec("git", ["-C", repoDir, "fetch", "origin", "main"], {
        timeout: 10000,
      });

      const log = await pi.exec(
        "git",
        [
          "-C",
          repoDir,
          "log",
          "--oneline",
          "--no-decorate",
          `${localHead}..origin/main`,
        ],
        { timeout: 5000 },
      );

      const commits = log.code === 0 ? log.stdout.trim() : "(failed to read commit list)";
      const count = commits && commits !== "(failed to read commit list)" ? commits.split("\n").length : "?";
      const message = buildMessage(count, commits || "(no commit details available)");

      state.lastCheckedDay = today;
      state.pending = {
        localHead,
        remoteHead,
        commits,
        message,
        detectedAt: new Date().toISOString(),
      };
      addEvent(state, "update_available", `${localHead.slice(0, 12)}..${remoteHead.slice(0, 12)}`);
      saveState(state);

      sendPendingMessage(pi, state);
    } catch {
      state.lastCheckedDay = today;
      addEvent(state, "check_failed", "unexpected exception");
      saveState(state);
      sendPendingMessage(pi, state);
    }
  });
}
