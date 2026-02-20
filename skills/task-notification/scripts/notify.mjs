#!/usr/bin/env node
/**
 * Cross-platform desktop notification sender.
 *
 * Usage:
 *   node notify.mjs --title "Title" --body "Body text"
 *
 * Supported platforms:
 *   macOS   — terminal-notifier (resolved via Homebrew, avoids shims)
 *   Linux   — notify-send (libnotify) → gdbus fallback
 *   Windows — PowerShell toast notification → BalloonTip fallback
 *
 * Exit codes:
 *   0 — notification sent (or best-effort)
 *   1 — missing arguments
 *   2 — no notification tool available on this platform
 */

import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Parse args ──────────────────────────────────────────────────────────────

function getArg(name) {
  const idx = process.argv.indexOf(name);
  if (idx === -1 || !process.argv[idx + 1]) return null;
  return process.argv[idx + 1];
}

const title = getArg("--title");
const body = getArg("--body");

if (!title || !body) {
  process.stderr.write(
    'Usage: node notify.mjs --title "Title" --body "Body text"\n'
  );
  process.exit(1);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Escape for PowerShell single-quoted strings */
function escapePowerShell(str) {
  return str.replace(/'/g, "''");
}

/** Run a command silently and return whether it succeeded */
function tryExec(cmd) {
  try {
    execSync(cmd, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Check if a file exists and is executable */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── macOS: resolve the real terminal-notifier binary ────────────────────────
//
// Version managers (asdf, mise, rbenv) install shims that shadow the real
// Homebrew binary. Those shims may silently succeed but never deliver a
// notification. We resolve the Homebrew-installed binary explicitly.

function findTerminalNotifier() {
  // 1. Ask Homebrew directly (works regardless of CPU arch)
  try {
    const prefix = execSync("brew --prefix terminal-notifier 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    const bin = path.join(prefix, "bin", "terminal-notifier");
    if (isExecutable(bin)) return bin;
  } catch {
    // brew not on PATH or terminal-notifier not installed via brew
  }

  // 2. Well-known Homebrew paths (Apple Silicon, Intel)
  const knownPaths = [
    "/opt/homebrew/bin/terminal-notifier",
    "/usr/local/bin/terminal-notifier",
  ];
  for (const p of knownPaths) {
    if (isExecutable(p)) return p;
  }

  // 3. Last resort — whatever is on PATH (may be a shim; warn if so)
  try {
    const resolved = execSync("which terminal-notifier 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    if (resolved && isExecutable(resolved)) {
      // Detect shims: asdf, mise, rbenv shim directories
      const shimDirs = [".asdf/shims", ".mise/shims", ".rbenv/shims"];
      const isShim = shimDirs.some((d) => resolved.includes(d));
      if (isShim) {
        process.stderr.write(
          `⚠️  Found terminal-notifier at ${resolved} but it looks like a shim.\n` +
            `   Install via Homebrew for reliable notifications: brew install terminal-notifier\n`
        );
        return null;
      }
      return resolved;
    }
  } catch {
    // not found
  }

  return null;
}

// ── Linux: find notify-send or gdbus ────────────────────────────────────────

function findLinuxNotifier() {
  // notify-send is the standard on most distros
  const knownPaths = [
    "/usr/bin/notify-send",
    "/usr/local/bin/notify-send",
    "/snap/bin/notify-send",
  ];
  for (const p of knownPaths) {
    if (isExecutable(p)) return { tool: "notify-send", path: p };
  }
  try {
    const resolved = execSync("which notify-send 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    if (resolved && isExecutable(resolved))
      return { tool: "notify-send", path: resolved };
  } catch {
    // not found
  }

  // Fallback: gdbus (GNOME-based systems)
  for (const p of ["/usr/bin/gdbus", "/usr/local/bin/gdbus"]) {
    if (isExecutable(p)) return { tool: "gdbus", path: p };
  }
  try {
    const resolved = execSync("which gdbus 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    if (resolved && isExecutable(resolved))
      return { tool: "gdbus", path: resolved };
  } catch {
    // not found
  }

  return null;
}

// ── Escape helper for gdbus shell invocation ────────────────────────────────

function escapeShell(str) {
  return str.replace(/'/g, "'\\''");
}

// ── Platform dispatch ───────────────────────────────────────────────────────

const platform = os.platform();

if (platform === "darwin") {
  // ── macOS ───────────────────────────────────────────────────────────────
  const bin = findTerminalNotifier();
  if (!bin) {
    process.stderr.write(
      "⚠️  terminal-notifier not found.\n" +
        "   Install it with: brew install terminal-notifier\n"
    );
    process.exit(2);
  }

  const result = spawnSync(bin, [
    "-title",
    title,
    "-message",
    body,
    "-sound",
    "default",
    "-group",
    "pi-task-notification",
  ], { stdio: "ignore" });

  if (result.status === 0) {
    process.stderr.write(`✅ Notification sent (macOS terminal-notifier)\n`);
  } else {
    process.stderr.write(
      `⚠️  terminal-notifier exited with status ${result.status}.\n` +
        `   Check System Settings → Notifications → terminal-notifier is allowed.\n`
    );
  }
} else if (platform === "linux") {
  // ── Linux ───────────────────────────────────────────────────────────────
  const notifier = findLinuxNotifier();
  if (!notifier) {
    process.stderr.write(
      "⚠️  No notification tool found.\n" +
        "   Debian/Ubuntu: sudo apt install libnotify-bin\n" +
        "   Fedora/RHEL:   sudo dnf install libnotify\n" +
        "   Arch:          sudo pacman -S libnotify\n"
    );
    process.exit(2);
  }

  if (notifier.tool === "notify-send") {
    const result = spawnSync(notifier.path, [
      "--app-name=pi",
      title,
      body,
    ], { stdio: "ignore" });

    if (result.status === 0) {
      process.stderr.write("✅ Notification sent (Linux notify-send)\n");
    } else {
      process.stderr.write("⚠️  notify-send failed.\n");
    }
  } else {
    // gdbus fallback
    const ok = tryExec(
      `'${escapeShell(notifier.path)}' call --session ` +
        `--dest org.freedesktop.Notifications ` +
        `--object-path /org/freedesktop/Notifications ` +
        `--method org.freedesktop.Notifications.Notify ` +
        `'pi' 0 '' '${escapeShell(title)}' '${escapeShell(body)}' '[]' '{}' 5000`
    );
    if (ok) {
      process.stderr.write("✅ Notification sent (Linux gdbus)\n");
    } else {
      process.stderr.write("⚠️  gdbus notification failed.\n");
    }
  }
} else if (platform === "win32") {
  // ── Windows ─────────────────────────────────────────────────────────────
  // Strategy 1: PowerShell toast via Windows.UI.Notifications (Win 10+)
  const toastScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null

$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>'${escapePowerShell(title)}'</text>
      <text>'${escapePowerShell(body)}'</text>
    </binding>
  </visual>
</toast>
"@

$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotifierManager]::CreateToastNotifier('pi').Show($toast)
`;

  let sent = false;

  // Try toast first
  const toastResult = spawnSync("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    toastScript,
  ], { stdio: "ignore" });

  if (toastResult.status === 0) {
    process.stderr.write("✅ Notification sent (Windows Toast)\n");
    sent = true;
  }

  // Strategy 2: BalloonTip fallback
  if (!sent) {
    const balloonScript = `
Add-Type -AssemblyName System.Windows.Forms
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${escapePowerShell(title)}'
$n.BalloonTipText = '${escapePowerShell(body)}'
$n.Visible = $true
$n.ShowBalloonTip(5000)
Start-Sleep -Seconds 6
$n.Dispose()
`;

    const balloonResult = spawnSync("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      balloonScript,
    ], { stdio: "ignore" });

    if (balloonResult.status === 0) {
      process.stderr.write("✅ Notification sent (Windows BalloonTip)\n");
      sent = true;
    }
  }

  if (!sent) {
    process.stderr.write(
      "⚠️  Could not send notification on Windows.\n" +
        "   Requires Windows 10+ with PowerShell 5+.\n"
    );
    process.exit(2);
  }
} else {
  process.stderr.write(
    `⚠️  Unsupported platform: ${platform}. Notifications not available.\n`
  );
  process.exit(2);
}
