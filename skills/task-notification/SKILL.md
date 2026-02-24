---
name: task-notification
description: >
  Send a desktop notification when pi finishes a task. Works on macOS, Windows,
  and Linux. On first use, interactively asks the user to choose a notification
  preference (always, ask every time, or never) via arrow-key selector. Use this
  skill at the end of every task completion — after committing, after finishing
  a code change, after answering a question, or any other unit of work.
---

# Task Notification

Send a native desktop notification when pi finishes working on a task so the
user knows it's done — even if they've switched to another window.

The notification includes the **process name** running pi and a **short
description** of the task that was completed.

## Preference File

Preferences are stored at `~/.pi/task-notification-prefs.json`:

```json
{
  "preference": "always"
}
```

Valid values: `"always"` | `"ask"` | `"never"`

## Procedure

Follow these steps **every time** you finish a task.

### Step 1 — Check if preference exists

```bash
cat ~/.pi/task-notification-prefs.json 2>/dev/null
```

If the file **does not exist** or is invalid JSON, go to **Step 2**.
If the file exists, read the `preference` value and skip to **Step 3**.

### Step 2 — First-time setup: ask the user

This is the first time notifications are being used. Run the interactive
preference selector so the user can pick with arrow keys and Enter:

```bash
node scripts/select-preference.mjs
```

This script:
- Renders a single-select menu with three options: **Always notify**,
  **Ask every time**, **Never notify**
- User navigates with **↑/↓ arrow keys** (or k/j) and confirms with **Enter**
- Saves the choice to `~/.pi/task-notification-prefs.json`
- Prints the chosen key to stdout (`always`, `ask`, or `never`)
- If the user presses `q` or Ctrl-C, exits with code 1 — treat this as
  `"never"` for this session only (don't save anything)
- If no interactive terminal is available (exit code 3), **fall back** to
  using the `ask_user_question` tool with the same three options:
  - **Always notify** — save `"always"` to the prefs file
  - **Ask every time** — save `"ask"` to the prefs file
  - **Never notify** — save `"never"` to the prefs file
  Then write the prefs file yourself:
  ```bash
  echo '{"preference": "<chosen_key>"}' > ~/.pi/task-notification-prefs.json
  ```

Read the stdout output (or the ask_user_question result) to determine the
preference, then continue to Step 3.

### Step 3 — Test notification (first-time only)

This step runs **only** during first-time setup (i.e. when Step 2 just ran).
Skip this step entirely on subsequent task completions.

If the user chose `"never"`, skip to Step 4.

If the user chose `"always"` or `"ask"`, send a test notification:

```bash
node scripts/notify.mjs \
  --title "🔔 pi — Test Notification" \
  --body "If you can see this, notifications are working!"
```

Then ask the user using `ask_user_question`:

> "I just sent a test notification. Did you see it?"

With options:
- **Yes, I saw it** — Great, setup is complete. Continue to Step 4.
- **No, I didn't see it** — Run the diagnostics script and show suggestions.

#### If the user did NOT see the test notification

Run the diagnostics script:

```bash
node scripts/diagnose.mjs
```

This outputs a JSON object to stdout with `checks` (pass/fail items) and
`suggestions` (actionable fixes). It also prints a human-readable summary
to stderr.

Present the results to the user clearly:

1. Show each failed check with its detail.
2. Show every suggestion as a numbered action item.
3. After presenting, ask the user using `ask_user_question`:

   > "Would you like to try again after making changes?"

   With options:
   - **Try again** — re-send the test notification (repeat this step)
   - **Skip for now** — save the preference as-is and continue; the user
     can fix settings later and notifications will work on the next task

If "Try again", re-run the test notification and re-ask. Loop until the user
sees it or chooses to skip.

### Step 4 — Act on the preference

Based on the preference value:

#### `"never"`
Do nothing. Do not send a notification. Done.

#### `"always"`
Go directly to **Step 5**.

#### `"ask"`
Use the `ask_user_question` tool to ask:

> "Task complete. Send a desktop notification?"

With options:
- **Yes** — proceed to Step 5
- **No** — done, do not notify

### Step 5 — Determine notification content

Build two values:

1. **Title** — The parent process name running pi. Detect it:
   ```bash
   ps -o comm= -p $PPID 2>/dev/null || echo "pi"
   ```
   Format the title as: `✅ <process_name> — Task Complete`
   (e.g. `✅ zsh — Task Complete` or `✅ Terminal — Task Complete`)

2. **Body** — A short, human-readable summary (under 120 characters) of what
   task you just finished. Examples:
   - `Added notification skill with cross-platform support`
   - `Fixed permission check in api-auth handler`
   - `Created PR #42 for form validation feature`
   - `Committed 3 files: updated user dashboard filters`

   Keep it concise — this appears in a system notification bubble.

### Step 6 — Send the notification

```bash
node scripts/notify.mjs \
  --title "<title from step 4>" \
  --body "<body from step 4>"
```

The script auto-detects the OS and uses:
- **macOS**: `terminal-notifier` (Notification Center, with sound and grouping)
- **Linux**: `notify-send` (libnotify) with `gdbus` fallback
- **Windows**: PowerShell toast notification with BalloonTip fallback

If the notification fails, log the warning but do **not** treat it as an error
for the user's task.

## Resetting Preferences

If the user wants to change their notification preference, tell them to delete
the file and the next task will prompt again:

```bash
rm ~/.pi/task-notification-prefs.json
```

Or they can edit it directly:

```bash
echo '{"preference": "always"}' > ~/.pi/task-notification-prefs.json
```

## Platform Notes

| Platform | Mechanism | Install |
|----------|-----------|---------|
| macOS (Apple Silicon) | `terminal-notifier` via Homebrew at `/opt/homebrew/bin/` | `brew install terminal-notifier` |
| macOS (Intel) | `terminal-notifier` via Homebrew at `/usr/local/bin/` | `brew install terminal-notifier` |
| Linux (Debian/Ubuntu) | `notify-send` → `gdbus` fallback | `sudo apt install libnotify-bin` |
| Linux (Fedora/RHEL) | `notify-send` → `gdbus` fallback | `sudo dnf install libnotify` |
| Linux (Arch) | `notify-send` → `gdbus` fallback | `sudo pacman -S libnotify` |
| Windows 10+ | PowerShell Toast → BalloonTip fallback | Built-in (PowerShell 5+) |

### macOS binary resolution

The script resolves `terminal-notifier` in this order to **avoid version
manager shims** (asdf, mise, rbenv) that silently succeed but never deliver:

1. `brew --prefix terminal-notifier` → use that installation's `bin/`
2. `/opt/homebrew/bin/terminal-notifier` (Apple Silicon default)
3. `/usr/local/bin/terminal-notifier` (Intel default)
4. `which terminal-notifier` — only if it is **not** inside a known shim
   directory (`.asdf/shims`, `.mise/shims`, `.rbenv/shims`)

If none resolve, the script exits with code 2 and prints install instructions.

### Linux binary resolution

1. `/usr/bin/notify-send`, `/usr/local/bin/notify-send`, `/snap/bin/notify-send`
2. `which notify-send`
3. Fallback: `gdbus` (GNOME D-Bus) at known paths or via `which`

### Windows

Tries PowerShell `Windows.UI.Notifications` toast first, then falls back to
`System.Windows.Forms.NotifyIcon` balloon tip. Uses `spawnSync` with
`-NoProfile -NonInteractive` flags so it works in non-interactive shells.

## Troubleshooting

- **macOS "terminal-notifier not found"**: Run `brew install terminal-notifier`
- **macOS shim warning**: The script detected a version-manager shim instead of
  the real binary. Run `brew install terminal-notifier` so the Homebrew binary
  is available at a known path.
- **macOS notifications not appearing**: Check System Settings → Notifications →
  terminal-notifier is allowed. Also ensure Focus / Do Not Disturb is off.
- **Linux "No notification tool found"**: Install libnotify for your distro
  (see table above).
- **Windows toast fails**: The BalloonTip fallback should work on Windows 10+.
  If both fail, ensure PowerShell execution policy allows scripts:
  `Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`
