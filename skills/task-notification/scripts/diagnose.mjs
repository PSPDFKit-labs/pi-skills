#!/usr/bin/env node
/**
 * Diagnose notification delivery issues per platform.
 *
 * Usage:
 *   node diagnose.mjs
 *
 * Prints a JSON object to stdout with:
 *   { platform, checks: [...], suggestions: [...] }
 *
 * Each check: { name, passed, detail }
 * Each suggestion: string with actionable fix
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const platform = os.platform();
const checks = [];
const suggestions = [];

function check(name, passed, detail) {
  checks.push({ name, passed, detail });
}

function suggest(msg) {
  suggestions.push(msg);
}

// ── macOS diagnostics ───────────────────────────────────────────────────────

if (platform === "darwin") {
  // 1. Is terminal-notifier installed via Homebrew?
  let brewBin = null;
  try {
    const prefix = execSync("brew --prefix terminal-notifier 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    brewBin = path.join(prefix, "bin", "terminal-notifier");
    if (!fs.existsSync(brewBin)) brewBin = null;
  } catch {}

  if (!brewBin) {
    // Check well-known paths
    for (const p of [
      "/opt/homebrew/bin/terminal-notifier",
      "/usr/local/bin/terminal-notifier",
    ]) {
      if (fs.existsSync(p)) {
        brewBin = p;
        break;
      }
    }
  }

  if (brewBin) {
    check("terminal-notifier installed (Homebrew)", true, brewBin);
  } else {
    check("terminal-notifier installed (Homebrew)", false, "Not found");
    suggest("Install terminal-notifier: brew install terminal-notifier");
  }

  // 2. Check for shim conflicts
  try {
    const which = execSync("which terminal-notifier 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
    const shimDirs = [".asdf/shims", ".mise/shims", ".rbenv/shims"];
    const isShim = shimDirs.some((d) => which.includes(d));
    if (isShim) {
      check("No shim conflict", false, `Shim found at ${which}`);
      suggest(
        `A version-manager shim at ${which} shadows the real binary. ` +
          `The skill resolves Homebrew directly, but you may want to remove the shim: ` +
          `gem uninstall terminal-notifier (if installed via Ruby gems)`
      );
    } else {
      check("No shim conflict", true, which);
    }
  } catch {
    check("No shim conflict", true, "No terminal-notifier on PATH at all");
  }

  // 3. Check Focus / Do Not Disturb
  let focusActive = false;
  try {
    const assertionsPath = path.join(
      os.homedir(),
      "Library/DoNotDisturb/DB/Assertions.json"
    );
    if (fs.existsSync(assertionsPath)) {
      const data = JSON.parse(fs.readFileSync(assertionsPath, "utf-8"));
      if (
        data?.data?.length > 0 ||
        (data?.storeAssertionRecords && data.storeAssertionRecords.length > 0)
      ) {
        focusActive = true;
      }
    }
  } catch {}

  // Also check via defaults
  try {
    const dndPref = execSync(
      "defaults read com.apple.controlcenter 'NSStatusItem Visible FocusModes' 2>/dev/null",
      { encoding: "utf-8" }
    ).trim();
    // This just tells us if the control center icon is visible, not if focus is active
  } catch {}

  if (focusActive) {
    check("Focus / Do Not Disturb", false, "A Focus mode appears active");
    suggest(
      "Turn off Focus / Do Not Disturb: click the Control Center icon in " +
        "the menu bar → Focus → turn off, or go to System Settings → Focus"
    );
  } else {
    check("Focus / Do Not Disturb", true, "No active Focus mode detected");
  }

  // 4. Check notification permissions for terminal-notifier
  let tnAllowed = null;
  try {
    const ncprefs = execSync(
      "defaults read com.apple.ncprefs apps 2>/dev/null",
      { encoding: "utf-8" }
    );
    // Look for terminal-notifier bundle id
    if (ncprefs.includes("fr.julienxx.oss.terminal-notifier")) {
      // Check if flags indicate notifications are enabled
      // flags with bit 2 set (value & 2) means notifications are disabled
      // This is complex to parse, so just check presence
      tnAllowed = true;
      check(
        "terminal-notifier in Notification Center",
        true,
        "Registered in notification preferences"
      );
    } else {
      tnAllowed = false;
      check(
        "terminal-notifier in Notification Center",
        false,
        "Not yet registered — may appear after first notification attempt"
      );
      suggest(
        "terminal-notifier may not be registered in Notification Center yet. " +
          "After the first attempt, go to System Settings → Notifications → " +
          "terminal-notifier and ensure:\n" +
          "  • 'Allow Notifications' is ON\n" +
          "  • Alert style is set to 'Alerts' or 'Banners' (not 'None')"
      );
    }
  } catch {
    check(
      "terminal-notifier in Notification Center",
      false,
      "Could not read notification preferences"
    );
    suggest(
      "Check System Settings → Notifications → scroll to terminal-notifier:\n" +
        "  • 'Allow Notifications' must be ON\n" +
        "  • Alert style should be 'Alerts' or 'Banners' (not 'None')\n" +
        "  • If terminal-notifier is not listed, send a test notification first — " +
        "it registers on first use"
    );
  }

  // 5. macOS version check (notifications API changed in Ventura)
  try {
    const ver = execSync("sw_vers -productVersion", { encoding: "utf-8" }).trim();
    check("macOS version", true, ver);
  } catch {
    check("macOS version", false, "Could not determine");
  }
} else if (platform === "linux") {
  // ── Linux diagnostics ──────────────────────────────────────────────────

  // 1. notify-send available?
  let notifySendPath = null;
  for (const p of [
    "/usr/bin/notify-send",
    "/usr/local/bin/notify-send",
    "/snap/bin/notify-send",
  ]) {
    if (fs.existsSync(p)) {
      notifySendPath = p;
      break;
    }
  }
  if (!notifySendPath) {
    try {
      notifySendPath = execSync("which notify-send 2>/dev/null", {
        encoding: "utf-8",
      }).trim();
    } catch {}
  }

  if (notifySendPath) {
    check("notify-send installed", true, notifySendPath);
  } else {
    check("notify-send installed", false, "Not found");
    suggest(
      "Install libnotify:\n" +
        "  Debian/Ubuntu: sudo apt install libnotify-bin\n" +
        "  Fedora/RHEL:   sudo dnf install libnotify\n" +
        "  Arch:          sudo pacman -S libnotify"
    );
  }

  // 2. D-Bus session bus
  const dbusAddr = process.env.DBUS_SESSION_BUS_ADDRESS;
  if (dbusAddr) {
    check("D-Bus session bus", true, dbusAddr);
  } else {
    check("D-Bus session bus", false, "DBUS_SESSION_BUS_ADDRESS not set");
    suggest(
      "The D-Bus session bus is not available. Notifications require a " +
        "running D-Bus session. This is usually set in a desktop environment. " +
        "If you're in SSH or a headless session, notifications won't work."
    );
  }

  // 3. Notification daemon running?
  const daemons = [
    "dunst",
    "mako",
    "swaync",
    "xfce4-notifyd",
    "notification-daemon",
    "notify-osd",
    "lxqt-notificationd",
    "deadd-notification-center",
  ];
  let foundDaemon = null;
  try {
    const ps = execSync("ps -eo comm 2>/dev/null", { encoding: "utf-8" });
    for (const d of daemons) {
      if (ps.includes(d)) {
        foundDaemon = d;
        break;
      }
    }
  } catch {}

  if (foundDaemon) {
    check("Notification daemon running", true, foundDaemon);
  } else {
    check("Notification daemon running", false, "No known daemon detected");
    suggest(
      "No notification daemon detected. Your desktop environment should " +
        "provide one. Common daemons:\n" +
        "  GNOME:  built-in (gnome-shell)\n" +
        "  KDE:    built-in (plasmashell)\n" +
        "  i3/Sway: install dunst or mako\n" +
        "  XFCE:   xfce4-notifyd (usually pre-installed)"
    );
  }

  // 4. Display server
  const waylandDisplay = process.env.WAYLAND_DISPLAY;
  const x11Display = process.env.DISPLAY;
  if (waylandDisplay) {
    check("Display server", true, `Wayland (${waylandDisplay})`);
  } else if (x11Display) {
    check("Display server", true, `X11 (${x11Display})`);
  } else {
    check("Display server", false, "No DISPLAY or WAYLAND_DISPLAY set");
    suggest(
      "No display server detected. Notifications require a graphical " +
        "session (X11 or Wayland). They won't work in a headless/SSH session."
    );
  }
} else if (platform === "win32") {
  // ── Windows diagnostics ────────────────────────────────────────────────

  // 1. PowerShell available?
  try {
    const psVer = execSync(
      'powershell -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"',
      { encoding: "utf-8" }
    ).trim();
    check("PowerShell", true, `Version ${psVer}`);
    if (parseInt(psVer.split(".")[0], 10) < 5) {
      suggest("PowerShell 5+ is recommended. Update via Windows Update or install PowerShell 7.");
    }
  } catch {
    check("PowerShell", false, "Could not invoke PowerShell");
    suggest("Ensure PowerShell is installed and on PATH.");
  }

  // 2. Windows version (toast requires Win 10+)
  try {
    const ver = execSync(
      'powershell -NoProfile -Command "[System.Environment]::OSVersion.Version.ToString()"',
      { encoding: "utf-8" }
    ).trim();
    const major = parseInt(ver.split(".")[0], 10);
    if (major >= 10) {
      check("Windows version", true, ver);
    } else {
      check("Windows version", false, ver);
      suggest("Toast notifications require Windows 10 or later.");
    }
  } catch {
    check("Windows version", false, "Could not determine");
  }

  // 3. Notifications enabled in Windows Settings?
  try {
    const enabled = execSync(
      'powershell -NoProfile -Command "(Get-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications\' -Name \'ToastEnabled\' -ErrorAction SilentlyContinue).ToastEnabled"',
      { encoding: "utf-8" }
    ).trim();
    if (enabled === "1") {
      check("Notifications enabled (registry)", true, "ToastEnabled = 1");
    } else if (enabled === "0") {
      check("Notifications enabled (registry)", false, "ToastEnabled = 0");
      suggest(
        "Notifications are disabled in Windows Settings.\n" +
          "Go to Settings → System → Notifications and enable " +
          "'Get notifications from apps and other senders'."
      );
    } else {
      check("Notifications enabled (registry)", true, "Default (enabled)");
    }
  } catch {
    check("Notifications enabled (registry)", true, "Could not check, assuming enabled");
  }

  // 4. Focus Assist
  suggest(
    "If notifications still don't appear, check Focus Assist:\n" +
      "Settings → System → Focus Assist → set to 'Off' or add pi to priority list."
  );
} else {
  check("Platform", false, platform);
  suggest(`Platform '${platform}' is not supported for desktop notifications.`);
}

// ── Output ──────────────────────────────────────────────────────────────────

const result = { platform, checks, suggestions };
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

// Also print human-readable summary to stderr
process.stderr.write("\n🔍 Notification Diagnostics\n");
process.stderr.write(`   Platform: ${platform}\n\n`);

for (const c of checks) {
  const icon = c.passed ? "✅" : "❌";
  process.stderr.write(`   ${icon} ${c.name}: ${c.detail}\n`);
}

if (suggestions.length > 0) {
  process.stderr.write("\n💡 Suggestions:\n");
  for (let i = 0; i < suggestions.length; i++) {
    const lines = suggestions[i].split("\n");
    process.stderr.write(`\n   ${i + 1}. ${lines[0]}\n`);
    for (let j = 1; j < lines.length; j++) {
      process.stderr.write(`      ${lines[j]}\n`);
    }
  }
}

process.stderr.write("\n");
