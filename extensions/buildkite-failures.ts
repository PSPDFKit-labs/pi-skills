import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, DynamicBorder } from "@mariozechner/pi-coding-agent";
import type { Component, SelectItem } from "@mariozechner/pi-tui";
import {
  Container,
  Spacer,
  Text,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import path from "node:path";
import { fileURLToPath } from "node:url";

type BuildkiteUrlParts = {
  readonly orgSlug: string;
  readonly pipelineSlug: string;
  readonly buildNumber: string;
};

type TestSummaryEntry = {
  readonly testName: string;
  readonly labels: Array<string>;
  readonly count: number;
};

type TestEntry = {
  readonly name: string;
  readonly row: number;
};

type TestCategory = "everywhere" | "multiple" | "single";

type TestSummaryDetail = TestSummaryEntry & {
  readonly category: TestCategory;
};

type SummaryPayload = {
  readonly failedJobs: number;
  readonly environments: Array<string>;
  readonly uniqueFailingTests: number;
  readonly testsFailingEverywhere: Array<TestSummaryEntry>;
  readonly testsFailingMultiple: Array<TestSummaryEntry>;
  readonly testsFailingSingle: Array<TestSummaryEntry>;
  readonly jobErrors: Array<{ readonly jobName: string; readonly error: string }>;
  readonly testsByTest: Array<TestSummaryEntry>;
};

type JobPayload = {
  readonly jobName: string;
  readonly jobId: string;
  readonly jobUrl: string | null;
  readonly label: string;
  readonly state: string | null;
  readonly failedLine: string | null;
  readonly failedLineRow: number | null;
  readonly tests: Array<string>;
  readonly testEntries: Array<TestEntry>;
  readonly error: string | null;
};

type FailuresPayload = {
  readonly summary: SummaryPayload;
  readonly jobs: Array<JobPayload>;
  readonly meta?: {
    readonly cached: boolean;
    readonly cachePath: string;
    readonly cachedAt: string;
    readonly checkedAt: string;
  };
};

type CommandContext = Parameters<Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>[1];

type ErrorPayload = {
  readonly error: {
    readonly testName: string;
    readonly jobId: string;
    readonly jobUrl: string | null;
    readonly matchRow: number;
    readonly startRow: number | null;
    readonly endRow: number | null;
    readonly lines: Array<string>;
  };
  readonly meta: {
    readonly checkedAt: string;
  };
};

type ErrorLookupOptions = {
  readonly testName: string;
  readonly envEntry: TestJobEntry;
  readonly failedLineRow: number | null;
};

type SelectionResult = {
  readonly testName: string;
  readonly envEntry: TestJobEntry | null;
};

type TestJobEntry = {
  readonly jobId: string;
  readonly jobUrl: string | null;
  readonly label: string;
  readonly row: number | null;
};

const COMMAND_NAME = "bk-playwright-errors";
const CATEGORY_LABELS: Record<TestCategory, string> = {
  everywhere: "ALL",
  multiple: "MULTI",
  single: "SINGLE",
};
const ENVIRONMENT_ORDER = ["chromium", "mobile", "firefox", "webkit"];
const EXTENSION_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAILURE_SCRIPT_PATH = path.resolve(
  EXTENSION_ROOT,
  "skills",
  "buildkite-playwright-failures",
  "scripts",
  "extract-playwright-failures.cjs"
);

type FailureListTheme = {
  readonly selectedText: (text: string) => string;
  readonly description: (text: string) => string;
  readonly scrollInfo: (text: string) => string;
  readonly noMatch: (text: string) => string;
};

const LIST_PREFIX = {
  selected: "→ ",
  normal: "  ",
};

function truncateFromStart(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) {
    return "";
  }
  if (visibleWidth(text) <= width) {
    return text;
  }
  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= width) {
    return truncateToWidth(text, width, "");
  }
  const targetWidth = width - ellipsisWidth;
  let result = "";
  let consumed = 0;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const char = text[i] ?? "";
    const charWidth = visibleWidth(char);
    if (consumed + charWidth > targetWidth) {
      break;
    }
    result = char + result;
    consumed += charWidth;
  }
  return `${ellipsis}${result}`;
}

class FailureList implements Component {
  private items: Array<SelectItem>;
  private selectedIndex = 0;
  private maxVisible: number;
  private theme: FailureListTheme;

  public onSelect?: (item: SelectItem) => void;
  public onCancel?: () => void;
  public onSelectionChange?: (item: SelectItem) => void;

  constructor(items: Array<SelectItem>, maxVisible: number, theme: FailureListTheme) {
    this.items = items;
    this.maxVisible = maxVisible;
    this.theme = theme;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.up)) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
      this.notifySelectionChange();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const selectedItem = this.getSelectedItem();
      if (selectedItem && this.onSelect) {
        this.onSelect(selectedItem);
      }
      return;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.onCancel) {
        this.onCancel();
      }
    }
  }

  render(width: number): string[] {
    if (this.items.length === 0) {
      return [this.theme.noMatch("  No failing tests")];
    }

    const startIndex = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.items.length - this.maxVisible)
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
    const lines: string[] = [];

    for (let i = startIndex; i < endIndex; i += 1) {
      const item = this.items[i];
      if (!item) {
        continue;
      }
      const isSelected = i === this.selectedIndex;
      const prefix = isSelected ? LIST_PREFIX.selected : LIST_PREFIX.normal;
      const prefixWidth = visibleWidth(prefix);
      const displayValue = item.label || item.value;
      const descriptionText = item.description ? `  ${item.description}` : "";
      const descriptionWidth = visibleWidth(descriptionText);
      const minLabelWidth = 12;
      const includeDescription =
        descriptionText.length > 0 && width - prefixWidth - descriptionWidth >= minLabelWidth;
      const finalDescription = includeDescription ? descriptionText : "";
      const labelWidth = Math.max(1, width - prefixWidth - visibleWidth(finalDescription));
      const truncatedLabel = truncateFromStart(displayValue, labelWidth);

      let line = `${prefix}${truncatedLabel}`;
      if (finalDescription) {
        if (isSelected) {
          line = this.theme.selectedText(truncateToWidth(line + finalDescription, width, ""));
        } else {
          line = line + this.theme.description(finalDescription);
        }
      } else if (isSelected) {
        line = this.theme.selectedText(truncateToWidth(line, width, ""));
      } else {
        line = truncateToWidth(line, width, "");
      }

      lines.push(line);
    }

    if (startIndex > 0 || endIndex < this.items.length) {
      const scrollText = `  (${this.selectedIndex + 1}/${this.items.length})`;
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
    }

    return lines;
  }

  invalidate(): void {
    // No cached render state
  }

  getSelectedItem(): SelectItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  private notifySelectionChange(): void {
    const selectedItem = this.getSelectedItem();
    if (selectedItem && this.onSelectionChange) {
      this.onSelectionChange(selectedItem);
    }
  }
}

function normalizeBuildkiteInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "buildkite.com" || trimmed === "www.buildkite.com") {
    return "https://buildkite.com";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("buildkite.com/")) {
    return `https://${trimmed}`;
  }
  if (trimmed.startsWith("www.buildkite.com/")) {
    return `https://${trimmed.slice(4)}`;
  }
  if (trimmed.startsWith("/")) {
    return `https://buildkite.com${trimmed}`;
  }
  return `https://buildkite.com/${trimmed}`;
}

function parseBuildkiteUrl(input: string): BuildkiteUrlParts | null {
  const normalized = normalizeBuildkiteInput(input);
  if (!normalized) {
    return null;
  }
  try {
    const url = new URL(normalized);
    const segments = url.pathname.split("/").filter(Boolean);
    const buildsIndex = segments.indexOf("builds");
    if (buildsIndex === -1 || buildsIndex + 1 >= segments.length) {
      return null;
    }
    if (segments.length < 3) {
      return null;
    }
    const orgSlug = segments[0] ?? "";
    const pipelineSlug = segments[1] ?? "";
    const buildNumber = segments[buildsIndex + 1] ?? "";
    if (!orgSlug || !pipelineSlug || !buildNumber) {
      return null;
    }
    return { orgSlug, pipelineSlug, buildNumber };
  } catch {
    return null;
  }
}

function normalizeTestName(line: string): string {
  return line.replace(/^\[[^\]]+\]\s+›\s+/, "").trim();
}

function formatEnvironmentLabel(label: string): string {
  return label.replace(/\s+\(iframe\)/g, " (ifr)");
}

function compareEnvironmentLabels(left: string, right: string): number {
  const [leftBase, leftContext = "standalone"] = left.split(" (");
  const [rightBase, rightContext = "standalone"] = right.split(" (");
  const leftIndex = ENVIRONMENT_ORDER.includes(leftBase)
    ? ENVIRONMENT_ORDER.indexOf(leftBase)
    : ENVIRONMENT_ORDER.length;
  const rightIndex = ENVIRONMENT_ORDER.includes(rightBase)
    ? ENVIRONMENT_ORDER.indexOf(rightBase)
    : ENVIRONMENT_ORDER.length;
  if (leftIndex !== rightIndex) {
    return leftIndex - rightIndex;
  }
  const leftIframe = leftContext.startsWith("ifr") ? 1 : 0;
  const rightIframe = rightContext.startsWith("ifr") ? 1 : 0;
  if (leftIframe !== rightIframe) {
    return leftIframe - rightIframe;
  }
  return left.localeCompare(right);
}

function sortEnvironmentLabels(labels: Array<string>): Array<string> {
  return [...labels].sort(compareEnvironmentLabels);
}

function uniqueEnvironmentLabels(labels: Array<string>): Array<string> {
  const formatted = labels.map(formatEnvironmentLabel);
  return sortEnvironmentLabels(Array.from(new Set(formatted)));
}

function buildSummaryDetails(summary: SummaryPayload): Array<TestSummaryDetail> {
  const categoryMap = new Map<string, TestCategory>();
  for (const entry of summary.testsFailingEverywhere) {
    categoryMap.set(entry.testName, "everywhere");
  }
  for (const entry of summary.testsFailingMultiple) {
    categoryMap.set(entry.testName, "multiple");
  }
  for (const entry of summary.testsFailingSingle) {
    categoryMap.set(entry.testName, "single");
  }

  return summary.testsByTest.map((entry) => ({
    ...entry,
    category: categoryMap.get(entry.testName) ?? "single",
  }));
}

function buildSummaryDetailMap(details: Array<TestSummaryDetail>): Map<string, TestSummaryDetail> {
  const map = new Map<string, TestSummaryDetail>();
  for (const detail of details) {
    map.set(detail.testName, detail);
  }
  return map;
}

function selectItemsFromSummary(details: Array<TestSummaryDetail>): Array<SelectItem> {
  const categoryRank: Record<TestCategory, number> = {
    everywhere: 0,
    multiple: 1,
    single: 2,
  };

  const sorted = [...details].sort((a, b) => {
    const categoryDiff = categoryRank[a.category] - categoryRank[b.category];
    if (categoryDiff !== 0) {
      return categoryDiff;
    }
    if (a.count !== b.count) {
      return b.count - a.count;
    }
    return a.testName.localeCompare(b.testName);
  });

  return sorted.map((detail) => {
    const envCount = uniqueEnvironmentLabels(detail.labels).length;
    const envLabel = envCount === 1 ? "env" : "envs";
    return {
      value: detail.testName,
      label: detail.testName,
      description: `${CATEGORY_LABELS[detail.category]} • ${envCount} ${envLabel}`,
    };
  });
}

function buildTestJobEntriesMap(jobs: Array<JobPayload>): Map<string, Array<TestJobEntry>> {
  const map = new Map<string, Array<TestJobEntry>>();
  for (const job of jobs) {
    if (!job.jobId) {
      continue;
    }
    const label = formatEnvironmentLabel(job.label);
    const entries = Array.isArray(job.testEntries) && job.testEntries.length > 0
      ? job.testEntries.map((entry) => ({ name: entry.name, row: entry.row }))
      : job.tests.map((name) => ({ name, row: null }));

    for (const entry of entries) {
      const testName = normalizeTestName(entry.name);
      if (!testName) {
        continue;
      }
      const row = typeof entry.row === "number" ? entry.row : null;
      const list = map.get(testName) ?? [];
      list.push({ jobId: job.jobId, jobUrl: job.jobUrl ?? null, label, row });
      map.set(testName, list);
    }
  }
  return map;
}

function buildJobMetadataMap(jobs: Array<JobPayload>): Map<string, JobPayload> {
  const map = new Map<string, JobPayload>();
  for (const job of jobs) {
    if (job.jobId) {
      map.set(job.jobId, job);
    }
  }
  return map;
}

function sortTestJobEntries(entries: Array<TestJobEntry>): Array<TestJobEntry> {
  return [...entries].sort((left, right) => {
    const labelComparison = compareEnvironmentLabels(left.label, right.label);
    if (labelComparison !== 0) {
      return labelComparison;
    }
    if (left.row === null || right.row === null) {
      return left.row === null ? 1 : -1;
    }
    return left.row - right.row;
  });
}

function buildBuildkiteJobUrl(parts: BuildkiteUrlParts, jobId: string | null): string {
  const baseUrl = `https://buildkite.com/${parts.orgSlug}/${parts.pipelineSlug}/builds/${parts.buildNumber}`;
  if (!jobId) {
    return baseUrl;
  }
  return `${baseUrl}#${jobId}`;
}

function normalizeBuildkiteUrl(
  parts: BuildkiteUrlParts,
  jobId: string,
  url: string | null
): string {
  const trimmed = url?.trim() ?? "";
  if (!trimmed) {
    return buildBuildkiteJobUrl(parts, jobId);
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    return `https://buildkite.com${trimmed}`;
  }
  return buildBuildkiteJobUrl(parts, jobId);
}

function buildLogRangeUrl(
  parts: BuildkiteUrlParts,
  entry: TestJobEntry | null,
  startRow: number | null,
  endRow: number | null
): string {
  if (!entry) {
    return buildBuildkiteJobUrl(parts, null);
  }
  const baseUrl = normalizeBuildkiteUrl(parts, entry.jobId, entry.jobUrl);
  if (startRow === null) {
    return baseUrl;
  }
  const hashIndex = baseUrl.indexOf("#");
  const base = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const range =
    endRow && endRow !== startRow ? `L${startRow}-L${endRow}` : `L${startRow}`;
  return `${base}#${entry.jobId}/${range}`;
}

async function runFailuresWithLoader(
  pi: ExtensionAPI,
  ctx: CommandContext,
  parts: BuildkiteUrlParts
): Promise<FailuresPayload | null> {
  let loaderError: Error | null = null;
  const result = await ctx.ui.custom<FailuresPayload | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Fetching Buildkite failures...");
    loader.onAbort = () => done(null);

    runFailuresScript(pi, parts)
      .then((payload) => done(payload))
      .catch((error) => {
        loaderError = error instanceof Error ? error : new Error(String(error));
        done(null);
      });

    return loader;
  });

  if (loaderError) {
    throw loaderError;
  }

  return result;
}

async function runFailuresScript(
  pi: ExtensionAPI,
  parts: BuildkiteUrlParts
): Promise<FailuresPayload> {
  const scriptPath = FAILURE_SCRIPT_PATH;
  const args = [
    scriptPath,
    "--org",
    parts.orgSlug,
    "--pipeline",
    parts.pipelineSlug,
    "--build",
    parts.buildNumber,
  ];
  const result = await pi.exec("node", args, { timeout: 120_000 });
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "script failed";
    throw new Error(detail);
  }
  const output = result.stdout?.trim();
  if (!output) {
    throw new Error("script returned empty output");
  }
  return JSON.parse(output) as FailuresPayload;
}

async function runErrorLookupWithLoader(
  pi: ExtensionAPI,
  ctx: CommandContext,
  parts: BuildkiteUrlParts,
  options: ErrorLookupOptions
): Promise<ErrorPayload | null> {
  let loaderError: Error | null = null;
  const result = await ctx.ui.custom<ErrorPayload | null>((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, "Fetching error details...");
    loader.onAbort = () => done(null);

    runErrorLookupScript(pi, parts, options)
      .then((payload) => done(payload))
      .catch((error) => {
        loaderError = error instanceof Error ? error : new Error(String(error));
        done(null);
      });

    return loader;
  });

  if (loaderError) {
    throw loaderError;
  }

  return result;
}

async function runErrorLookupScript(
  pi: ExtensionAPI,
  parts: BuildkiteUrlParts,
  options: ErrorLookupOptions
): Promise<ErrorPayload> {
  const scriptPath = FAILURE_SCRIPT_PATH;
  const args = [
    scriptPath,
    "--org",
    parts.orgSlug,
    "--pipeline",
    parts.pipelineSlug,
    "--build",
    parts.buildNumber,
    "--error-for",
    options.testName,
    "--job-id",
    options.envEntry.jobId,
  ];
  if (options.envEntry.jobUrl) {
    args.push("--job-url", options.envEntry.jobUrl);
  }
  if (options.failedLineRow !== null) {
    args.push("--failed-line-row", String(options.failedLineRow));
  }

  const result = await pi.exec("node", args, { timeout: 120_000 });
  if (result.code !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "script failed";
    throw new Error(detail);
  }
  const output = result.stdout?.trim();
  if (!output) {
    throw new Error("script returned empty output");
  }
  return JSON.parse(output) as ErrorPayload;
}

function formatErrorOutput(
  payload: ErrorPayload,
  envEntry: TestJobEntry,
  parts: BuildkiteUrlParts
): string {
  const rangeLabel = payload.error.startRow === null
    ? "n/a"
    : payload.error.endRow && payload.error.endRow !== payload.error.startRow
      ? `L${payload.error.startRow}-L${payload.error.endRow}`
      : `L${payload.error.startRow}`;
  const logUrl = buildLogRangeUrl(
    parts,
    envEntry,
    payload.error.startRow,
    payload.error.endRow
  );
  const lines: Array<string> = [
    "Buildkite error",
    `Test: ${payload.error.testName}`,
    `Env: ${envEntry.label}`,
    `Job: ${payload.error.jobId}`,
    `Rows: ${rangeLabel}`,
    `Log: ${logUrl}`,
    "",
    ...payload.error.lines,
  ];
  return lines.join("\n");
}

async function renderSelectionDialog(
  ctx: CommandContext,
  summary: SummaryPayload,
  jobs: Array<JobPayload>
): Promise<SelectionResult | null> {
  const details = buildSummaryDetails(summary);
  const detailMap = buildSummaryDetailMap(details);
  const testEntriesMap = buildTestJobEntriesMap(jobs);
  const items = selectItemsFromSummary(details);
  if (items.length === 0) {
    ctx.ui.notify("No failing tests found.", "info");
    return null;
  }

  return await ctx.ui.custom<SelectionResult | null>(
    (tui, theme, _kb, done) => {
      const container = new Container();
      const titleText = new Text("", 1, 0);
      const summaryText = new Text("", 1, 0);
      const testNameText = new Text("", 1, 0);
      const detailsText = new Text("", 1, 0);
      const helpText = new Text("", 1, 0);

      const visibleCount = Math.min(items.length, 10);
      const failureList = new FailureList(items, visibleCount, {
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (text: string) => theme.fg("warning", text),
      });

      let selectedTestName: string | null = null;
      let selectedEnvIndex = 0;
      let currentEntries: Array<TestJobEntry> = [];

      const updateEntriesForTest = (testName: string | null): void => {
        selectedTestName = testName;
        if (!testName) {
          currentEntries = [];
          selectedEnvIndex = 0;
          return;
        }
        currentEntries = sortTestJobEntries(testEntriesMap.get(testName) ?? []);
        selectedEnvIndex = 0;
      };

      const getSelectedEntry = (): TestJobEntry | null => {
        if (!selectedTestName || currentEntries.length === 0) {
          return null;
        }
        const index = Math.min(selectedEnvIndex, currentEntries.length - 1);
        return currentEntries[index] ?? null;
      };

      const getSelectedEntryForTest = (testName: string): TestJobEntry | null => {
        if (selectedTestName === testName) {
          return getSelectedEntry();
        }
        const entries = sortTestJobEntries(testEntriesMap.get(testName) ?? []);
        return entries[0] ?? null;
      };

      const updateDetails = (testName: string | null): void => {
        if (!testName) {
          testNameText.setText(theme.fg("muted", "No test selected."));
          detailsText.setText(theme.fg("muted", "No environment details."));
          return;
        }

        testNameText.setText(theme.fg("accent", "Test: ") + theme.fg("muted", testName));

        const entry = getSelectedEntry();
        if (entry) {
          const indexLabel =
            currentEntries.length > 1 ? ` (${selectedEnvIndex + 1}/${currentEntries.length})` : "";
          const rowLabel = entry.row === null ? "n/a" : `L${entry.row}`;
          detailsText.setText(
            theme.fg("accent", "Env: ") +
              theme.fg("muted", `${entry.label}${indexLabel}`) +
              theme.fg("accent", " • Log: ") +
              theme.fg("muted", rowLabel)
          );
          return;
        }

        const detail = detailMap.get(testName);
        if (!detail) {
          detailsText.setText(theme.fg("muted", "No environment details."));
          return;
        }
        const envLabels = uniqueEnvironmentLabels(detail.labels);
        const envSuffix = envLabels.length === 1 ? "env" : "envs";
        const heading = `Environments (${envLabels.length} ${envSuffix}): `;
        const envList = envLabels.length === 0 ? "none" : envLabels.join(", ");
        detailsText.setText(theme.fg("accent", heading) + theme.fg("muted", envList));
      };

      const applyTheme = (): void => {
        titleText.setText(theme.fg("accent", theme.bold("Playwright failures")));
        summaryText.setText(
          theme.fg(
            "dim",
            `${summary.uniqueFailingTests} failing tests • ${summary.failedJobs} failed jobs`
          )
        );
        helpText.setText(theme.fg("dim", "↑↓ navigate • tab env • enter load • esc cancel"));
        const selected = failureList.getSelectedItem();
        updateEntriesForTest(selected?.value ?? null);
        updateDetails(selected?.value ?? null);
      };

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(titleText);
      container.addChild(summaryText);
      container.addChild(new Spacer(1));

      failureList.onSelect = (item) => {
        done({ testName: item.value, envEntry: getSelectedEntryForTest(item.value) });
      };
      failureList.onCancel = () => done(null);
      failureList.onSelectionChange = (item) => {
        updateEntriesForTest(item.value);
        updateDetails(item.value);
        tui.requestRender();
      };

      container.addChild(failureList);
      container.addChild(new Spacer(1));
      container.addChild(testNameText);
      container.addChild(detailsText);
      container.addChild(new Spacer(1));
      container.addChild(helpText);
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

      applyTheme();

      return {
        render: (width: number) => container.render(width),
        invalidate: () => {
          container.invalidate();
          applyTheme();
        },
        handleInput: (data: string) => {
          if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
            if (currentEntries.length > 0) {
              const direction = matchesKey(data, Key.shift("tab")) ? -1 : 1;
              selectedEnvIndex =
                (selectedEnvIndex + direction + currentEntries.length) % currentEntries.length;
              updateDetails(selectedTestName);
              tui.requestRender();
            }
            return;
          }
          failureList.handleInput(data);
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "85%",
        maxHeight: "80%",
      },
    }
  );
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: "Show Buildkite Playwright errors for a build URL",
    handler: async (args, ctx) => {
      const input = args?.trim() ?? "";
      const url = input || (await ctx.ui.input("Buildkite build URL:", "https://buildkite.com/...")) || "";
      const parts = parseBuildkiteUrl(url);
      if (!parts) {
        ctx.ui.notify("Invalid Buildkite URL.", "error");
        return;
      }

      let payload: FailuresPayload | null;
      try {
        payload = await runFailuresWithLoader(pi, ctx, parts);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to fetch failures: ${message}`, "error");
        return;
      }

      if (!payload) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const selection = await renderSelectionDialog(ctx, payload.summary, payload.jobs);
      if (!selection) {
        return;
      }

      if (!selection.envEntry) {
        ctx.ui.notify("No environment selected for this test.", "warning");
        return;
      }

      const jobMetadata = buildJobMetadataMap(payload.jobs);
      const jobMeta = jobMetadata.get(selection.envEntry.jobId) ?? null;
      const envEntry: TestJobEntry = {
        ...selection.envEntry,
        jobUrl: selection.envEntry.jobUrl ?? jobMeta?.jobUrl ?? null,
      };

      let errorPayload: ErrorPayload | null;
      try {
        errorPayload = await runErrorLookupWithLoader(pi, ctx, parts, {
          testName: selection.testName,
          envEntry,
          failedLineRow: jobMeta?.failedLineRow ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to fetch error details: ${message}`, "error");
        return;
      }

      if (!errorPayload) {
        ctx.ui.notify("Cancelled.", "info");
        return;
      }

      const formatted = formatErrorOutput(errorPayload, envEntry, parts);
      ctx.ui.setEditorText(formatted);
    },
  });

}
