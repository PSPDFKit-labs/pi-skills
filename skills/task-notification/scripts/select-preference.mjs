#!/usr/bin/env node
/**
 * Interactive single-select prompt for notification preference.
 *
 * Usage:
 *   node select-preference.mjs
 *
 * Controls:
 *   ↑/↓  or  k/j  — move cursor
 *   Enter            — confirm selection
 *   q / Ctrl-C       — abort (exit 1, no preference saved)
 *
 * Saves preference to ~/.pi/task-notification-prefs.json
 * Output: The selected preference key on stdout ("always" | "ask" | "never").
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import tty from "node:tty";

// ── Options ─────────────────────────────────────────────────────────────────

const options = [
  {
    key: "always",
    label: "Always notify",
    description:
      "Send a desktop notification every time a task completes. No prompts.",
  },
  {
    key: "ask",
    label: "Ask every time",
    description:
      "Ask me whether to send a notification each time before sending.",
  },
  {
    key: "never",
    label: "Never notify",
    description:
      "Never send desktop notifications. You can change this later.",
  },
];

// ── State ───────────────────────────────────────────────────────────────────

let cursor = 0;

// ── Colors ──────────────────────────────────────────────────────────────────

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  const out = process.stderr;
  out.write("\x1b[H\x1b[J"); // clear screen

  out.write(
    `${BOLD}${CYAN}🔔 Task Notification Preference${RESET}\n`
  );
  out.write(
    `${DIM}How would you like to be notified when pi finishes a task?${RESET}\n`
  );
  out.write(
    `${DIM}(↑↓ move · enter confirm · q quit)${RESET}\n\n`
  );

  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const isCur = i === cursor;

    const pointer = isCur ? `${CYAN}❯${RESET}` : " ";
    const radio = isCur ? `${GREEN}●${RESET}` : `${DIM}○${RESET}`;
    const label = isCur ? `${BOLD}${opt.label}${RESET}` : opt.label;
    const desc = `\n      ${DIM}${opt.description}${RESET}`;
    out.write(`  ${pointer} ${radio} ${label}${desc}\n\n`);
  }

  out.write(
    `\n  ${DIM}Preference is saved to ~/.pi/task-notification-prefs.json${RESET}\n`
  );
  out.write(
    `  ${DIM}You can change it anytime by deleting that file or re-running this prompt.${RESET}\n`
  );
}

// ── Preference file ─────────────────────────────────────────────────────────

function savePreference(key) {
  const prefsDir = path.join(os.homedir(), ".pi");
  const prefsFile = path.join(prefsDir, "task-notification-prefs.json");
  fs.mkdirSync(prefsDir, { recursive: true });
  fs.writeFileSync(
    prefsFile,
    JSON.stringify({ preference: key }, null, 2) + "\n",
    "utf-8"
  );
}

// ── TTY setup ───────────────────────────────────────────────────────────────

let ttyFd = null;
let ttyIn;

try {
  ttyFd = fs.openSync("/dev/tty", "r");
  ttyIn = new tty.ReadStream(ttyFd);
} catch {
  // /dev/tty not available — try process.stdin if it's a TTY
  if (process.stdin.isTTY) {
    ttyIn = process.stdin;
  } else {
    // No interactive terminal available at all — exit with code 3
    // so the calling agent knows to fall back to ask_user_question
    process.stderr.write(
      "No interactive terminal available. Use pi's ask_user_question instead.\n"
    );
    process.exit(3);
  }
}

ttyIn.setRawMode(true);
ttyIn.setEncoding("utf-8");
ttyIn.resume();

function cleanup() {
  process.stderr.write("\x1b[?25h"); // show cursor
  process.stderr.write("\x1b[?1049l"); // leave alternate screen
  ttyIn.setRawMode(false);
  if (ttyFd !== null) {
    ttyIn.destroy();
    fs.closeSync(ttyFd);
  }
}

// Enter alternate screen, hide cursor
process.stderr.write("\x1b[?1049h");
process.stderr.write("\x1b[?25l");

render();

// ── Key handling ────────────────────────────────────────────────────────────

ttyIn.on("data", (key) => {
  // Ctrl-C or q → abort
  if (key === "\x03" || key === "q") {
    cleanup();
    process.stderr.write("Notification preference not set.\n");
    process.exit(1);
  }

  // Enter → confirm selection
  if (key === "\r" || key === "\n") {
    const chosen = options[cursor];
    savePreference(chosen.key);
    cleanup();
    process.stdout.write(chosen.key + "\n");
    process.exit(0);
  }

  // Up arrow or k
  if (key === "\x1b[A" || key === "k") {
    cursor = Math.max(0, cursor - 1);
    render();
    return;
  }

  // Down arrow or j
  if (key === "\x1b[B" || key === "j") {
    cursor = Math.min(options.length - 1, cursor + 1);
    render();
    return;
  }
});
