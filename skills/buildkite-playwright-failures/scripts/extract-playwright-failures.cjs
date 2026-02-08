#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_BKCI_PATH = process.env.BKCI_BIN || "bkci";
const CACHE_VERSION = 5;
const CACHE_DIR = path.join(os.tmpdir(), "pi-buildkite-playwright-failures");

const USAGE = `Usage:
  ./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER [--bkci-path PATH]
  ./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER --error-for "TEST_NAME" --job-id JOB_ID [--job-url URL] [--failed-line-row N] [--bkci-path PATH]

Options:
  --bkci-path PATH           bkci executable path (default: ${DEFAULT_BKCI_PATH})
  --error-for TEST_NAME      Fetch error details for a single test (requires --job-id)
  --job-id ID                Buildkite job id for error lookup
  --job-url URL              Buildkite job URL for log links (optional)
  --failed-line-row N        Row number of the summary block (optional)
  -h, --help                 Show this help
`;

function parseArgs(argv) {
  const args = {
    bkciPath: DEFAULT_BKCI_PATH,
    errorFor: null,
    jobId: null,
    jobUrl: null,
    failedLineRow: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") {
      return { help: true };
    }

    const next = argv[i + 1];
    switch (arg) {
      case "--org":
      case "--org-slug":
        args.org = next;
        i += 1;
        break;
      case "--pipeline":
      case "--pipeline-slug":
        args.pipeline = next;
        i += 1;
        break;
      case "--build":
      case "--build-number":
        args.build = next;
        i += 1;
        break;
      case "--bkci-path":
        args.bkciPath = next;
        i += 1;
        break;
      case "--error-for":
      case "--test-name":
        args.errorFor = next;
        i += 1;
        break;
      case "--job-id":
        args.jobId = next;
        i += 1;
        break;
      case "--job-url":
        args.jobUrl = next;
        i += 1;
        break;
      case "--failed-line-row":
        args.failedLineRow = toNonNegativeOption("--failed-line-row", next);
        i += 1;
        break;
      // Legacy options kept for compatibility. They are ignored with bkci.
      case "--server":
      case "--pattern":
      case "--search-limit":
      case "--context":
      case "--read-limit":
      case "--error-search-limit":
      case "--error-context":
      case "--error-read-limit":
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function toNonNegativeOption(label, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`missing value for ${label}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
}

function validateRequiredArgs(args) {
  const missing = ["org", "pipeline", "build"].filter((key) => !args[key]);
  if (missing.length > 0) {
    throw new Error(`missing required args: ${missing.join(", ")}`);
  }
}

function validateErrorArgs(args) {
  if (!args.errorFor) {
    return;
  }
  if (!args.errorFor.trim()) {
    throw new Error("missing test name for --error-for");
  }
  if (!args.jobId || !args.jobId.trim()) {
    throw new Error("missing required args for --error-for: job-id");
  }
}

function sanitizeKey(value) {
  return value.replace(/[^a-zA-Z0-9.-]+/g, "_");
}

function buildCachePath({ orgSlug, pipelineSlug, buildNumber, bkciPath }) {
  const safe = [bkciPath, orgSlug, pipelineSlug, buildNumber].map(sanitizeKey).join("__");
  return path.join(CACHE_DIR, `${safe}.json`);
}

async function loadCache(cachePath) {
  try {
    const raw = await fs.readFile(cachePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeCache(cachePath, data) {
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, JSON.stringify(data, null, 2));
}

function buildJobStates(jobs) {
  return Object.fromEntries(jobs.map((job) => [job.id, job.state ?? "unknown"]));
}

function areJobStatesEqual(left, right) {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => left[key] === right[key]);
}

function isCacheValid(cacheData, { orgSlug, pipelineSlug, buildNumber, bkciPath, jobStates }) {
  if (!cacheData || cacheData.version !== CACHE_VERSION) {
    return false;
  }
  const meta = cacheData.meta;
  if (!meta) {
    return false;
  }
  if (meta.orgSlug !== orgSlug || meta.pipelineSlug !== pipelineSlug || meta.buildNumber !== buildNumber) {
    return false;
  }
  if (meta.bkciPath !== bkciPath) {
    return false;
  }
  if (!meta.jobStates) {
    return false;
  }
  return areJobStatesEqual(meta.jobStates, jobStates);
}

function coerceString(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function extractBuildInfo(build, buildNumber) {
  return {
    number: build?.number !== undefined && build?.number !== null
      ? String(build.number)
      : String(buildNumber),
    url: coerceString(build?.web_url),
    branch: coerceString(build?.branch),
    commit: coerceString(build?.commit),
    message: coerceString(build?.message),
  };
}

function normalizeLogLine(text) {
  return String(text ?? "").trim();
}

function normalizeLogLinePreserveIndent(text) {
  return String(text ?? "").replace(/\r$/, "").trimEnd();
}

function normalizeTestName(line) {
  return line.replace(/^\[[^\]]+\]\s+›\s+/, "").trim();
}

function normalizeJobLabel(jobName) {
  const lower = jobName.toLowerCase();
  const isIframe = lower.includes("frame_with_picture") || lower.includes("iframe");
  let base = null;
  if (lower.includes("chromium")) {
    base = "chromium";
  } else if (lower.includes("firefox")) {
    base = "firefox";
  } else if (lower.includes("safari") || lower.includes("webkit")) {
    base = "webkit";
  } else if (lower.includes("mobile") || lower.includes("iphone")) {
    base = "mobile";
  }

  if (!base) {
    return jobName;
  }

  return isIframe ? `${base} (iframe)` : base;
}

function selectPlaywrightJobs(build) {
  if (!build || !Array.isArray(build.jobs)) {
    throw new Error("build response is missing jobs array");
  }
  return build.jobs
    .filter((job) => typeof job?.name === "string")
    .filter((job) => job.name.toLowerCase().includes("playwright"))
    .map((job) => {
      const rawUrl = typeof job?.web_url === "string" ? job.web_url.trim() : "";
      return {
        id: job.id,
        name: job.name,
        state: job.state,
        jobUrl: rawUrl ? rawUrl : null,
      };
    });
}

function filterFailedPlaywrightJobs(jobs) {
  return jobs.filter((job) => job.state === "failed");
}

function splitLogContent(content) {
  return String(content ?? "").split("\n");
}

function findFailedSummaryRow(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const content = normalizeLogLine(lines[i]);
    if (/\b\d+\s+failed\b/i.test(content)) {
      return i + 1;
    }
  }
  return null;
}

function extractFailedTests(lines) {
  const failedLineRow = findFailedSummaryRow(lines);
  if (failedLineRow === null) {
    return { failedLine: null, failedLineRow: null, tests: [], testEntries: [] };
  }

  const failedIndex = failedLineRow - 1;
  const failedLine = normalizeLogLine(lines[failedIndex]);
  const tests = [];
  const testEntries = [];

  for (let i = failedIndex + 1; i < lines.length; i += 1) {
    const line = normalizeLogLine(lines[i]);
    if (!line) {
      continue;
    }
    if (/\b\d+\s+(flaky|skipped|passed)\b/i.test(line)) {
      break;
    }
    tests.push(line);
    testEntries.push({ name: line, row: i + 1 });
  }

  return { failedLine, failedLineRow, tests, testEntries };
}

function isTestHeaderLine(text) {
  return /^\[[^\]]+\]\s+›/.test(text);
}

function isSummarySectionLine(text) {
  return /\b\d+\s+(failed|flaky|skipped|passed)\b/i.test(text);
}

function isRetryLine(text) {
  return /^Retry\s+#\d+/i.test(text);
}

function findTestMatchRow(lines, testName, failedLineRow) {
  const rows = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = normalizeLogLinePreserveIndent(lines[i]);
    if (!text.includes(testName)) {
      continue;
    }
    const row = i + 1;
    if (failedLineRow !== null && row >= failedLineRow) {
      continue;
    }
    rows.push(row);
  }

  if (rows.length === 0) {
    return null;
  }
  return Math.max(...rows);
}

function extractErrorBlock(lines, matchRow, testName) {
  let startIndex = matchRow - 1;
  if (startIndex < 0 || startIndex >= lines.length) {
    startIndex = lines.findIndex((line) => normalizeLogLinePreserveIndent(line).includes(testName));
  }
  if (startIndex === -1) {
    return { startRow: null, endRow: null, lines: [] };
  }

  const output = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const text = normalizeLogLinePreserveIndent(lines[i]);
    if (i > startIndex) {
      if (isTestHeaderLine(text) || isSummarySectionLine(text) || isRetryLine(text)) {
        break;
      }
    }
    output.push({ row: i + 1, text });
  }

  while (output.length > 0 && output[output.length - 1].text.trim() === "") {
    output.pop();
  }

  const startRow = output[0]?.row ?? null;
  const endRow = output[output.length - 1]?.row ?? null;
  return {
    startRow,
    endRow,
    lines: output.map((line) => line.text),
  };
}

function buildTestFailureMap(jobResults) {
  const map = new Map();
  for (const result of jobResults) {
    for (const rawTest of result.tests) {
      const testName = normalizeTestName(rawTest);
      if (!testName) {
        continue;
      }
      if (!map.has(testName)) {
        map.set(testName, new Set());
      }
      map.get(testName).add(result.label);
    }
  }
  return map;
}

function sortLabels(labels) {
  const baseOrder = ["chromium", "mobile", "firefox", "webkit"];
  const sorted = [...labels].sort((a, b) => {
    const [baseA, contextA = "standalone"] = a.split(" (");
    const [baseB, contextB = "standalone"] = b.split(" (");
    const baseIndexA = baseOrder.includes(baseA) ? baseOrder.indexOf(baseA) : baseOrder.length;
    const baseIndexB = baseOrder.includes(baseB) ? baseOrder.indexOf(baseB) : baseOrder.length;
    if (baseIndexA !== baseIndexB) {
      return baseIndexA - baseIndexB;
    }
    const contextRankA = contextA.startsWith("iframe") ? 1 : 0;
    const contextRankB = contextB.startsWith("iframe") ? 1 : 0;
    if (contextRankA !== contextRankB) {
      return contextRankA - contextRankB;
    }
    return a.localeCompare(b);
  });
  return sorted;
}

function buildSummaryData(jobResults) {
  const labelSet = new Set(jobResults.map((result) => result.label));
  const labels = sortLabels([...labelSet]);
  const testMap = buildTestFailureMap(jobResults);
  const testsByTest = [...testMap.entries()]
    .map(([testName, labelSetValue]) => ({
      testName,
      labels: sortLabels([...labelSetValue]),
      count: labelSetValue.size,
    }))
    .sort((a, b) => b.count - a.count || a.testName.localeCompare(b.testName));

  const labelCount = labels.length;
  const testsFailingEverywhere = testsByTest.filter((entry) => entry.count === labelCount && labelCount > 0);
  const testsFailingMultiple = testsByTest.filter((entry) => entry.count > 1 && entry.count < labelCount);
  const testsFailingSingle = testsByTest.filter((entry) => entry.count === 1);
  const errorJobs = jobResults.filter((result) => result.error).map((result) => ({
    jobName: result.jobName,
    error: result.error,
  }));

  return {
    failedJobs: jobResults.length,
    environments: labels,
    uniqueFailingTests: testsByTest.length,
    testsFailingEverywhere,
    testsFailingMultiple,
    testsFailingSingle,
    jobErrors: errorJobs,
    testsByTest,
  };
}

function getBuildkiteJobUrl(orgSlug, pipelineSlug, buildNumber, jobId) {
  const base = `https://buildkite.com/${orgSlug}/${pipelineSlug}/builds/${buildNumber}`;
  return jobId ? `${base}#${jobId}` : base;
}

async function runBkciJson(bkciPath, args) {
  let result;
  try {
    result = await execFileAsync(bkciPath, args, { maxBuffer: 1024 * 1024 * 25 });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const stdout = error?.stdout?.toString().trim();
    const detail = stderr || stdout || error.message;
    if (detail.includes("ENOENT") || /spawn .* ENOENT/i.test(detail)) {
      throw new Error("bkci not found. install from a local checkout: clone buildkite-cli, run 'pnpm install && pnpm run build', then 'npm link'");
    }
    throw new Error(detail);
  }

  const output = result.stdout?.trim();
  if (!output) {
    throw new Error("bkci returned empty output");
  }

  let envelope;
  try {
    envelope = JSON.parse(output);
  } catch (error) {
    throw new Error(`failed to parse bkci output: ${error.message}`);
  }

  if (!envelope || typeof envelope !== "object") {
    throw new Error("bkci returned invalid payload");
  }

  if (!envelope.ok) {
    const message = envelope?.error?.message || "bkci request failed";
    throw new Error(message);
  }

  return envelope;
}

async function fetchBuild({ orgSlug, pipelineSlug, buildNumber, bkciPath }) {
  const envelope = await runBkciJson(bkciPath, [
    "--raw",
    "builds",
    "get",
    "--org",
    orgSlug,
    "--pipeline",
    pipelineSlug,
    "--build",
    String(buildNumber),
  ]);

  return envelope.data;
}

async function fetchJobLog({ orgSlug, pipelineSlug, buildNumber, jobId, bkciPath }) {
  const envelope = await runBkciJson(bkciPath, [
    "jobs",
    "log",
    "get",
    "--org",
    orgSlug,
    "--pipeline",
    pipelineSlug,
    "--build",
    String(buildNumber),
    "--job",
    jobId,
  ]);

  return envelope?.data?.content ?? "";
}

async function fetchErrorPayload({
  orgSlug,
  pipelineSlug,
  buildNumber,
  bkciPath,
  testName,
  jobId,
  jobUrl,
  failedLineRow,
}) {
  const logContent = await fetchJobLog({ orgSlug, pipelineSlug, buildNumber, jobId, bkciPath });
  const lines = splitLogContent(logContent);

  const matchRow = findTestMatchRow(lines, testName, failedLineRow ?? null);
  if (matchRow === null) {
    throw new Error("no matching log entry found for test");
  }

  const errorBlock = extractErrorBlock(lines, matchRow, testName);
  if (errorBlock.lines.length === 0) {
    throw new Error("failed to extract error block for test");
  }

  return {
    error: {
      testName,
      jobId,
      jobUrl: jobUrl || null,
      matchRow,
      startRow: errorBlock.startRow,
      endRow: errorBlock.endRow,
      lines: errorBlock.lines,
    },
    meta: {
      checkedAt: new Date().toISOString(),
    },
  };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(USAGE.trim());
      return;
    }
    validateRequiredArgs(args);
    validateErrorArgs(args);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.log(USAGE.trim());
    process.exitCode = 1;
    return;
  }

  const orgSlug = args.org;
  const pipelineSlug = args.pipeline;
  const buildNumber = String(args.build);
  const bkciPath = args.bkciPath;

  if (args.errorFor) {
    let buildInfo = null;
    let resolvedJobUrl = args.jobUrl || null;
    try {
      const build = await fetchBuild({
        orgSlug,
        pipelineSlug,
        buildNumber,
        bkciPath,
      });
      buildInfo = extractBuildInfo(build, buildNumber);

      const jobs = Array.isArray(build?.jobs) ? build.jobs : [];
      const matchedJob = jobs.find((job) => job?.id === args.jobId);
      if (!resolvedJobUrl && matchedJob?.web_url) {
        resolvedJobUrl = matchedJob.web_url;
      }
    } catch {
      buildInfo = null;
      resolvedJobUrl = resolvedJobUrl || getBuildkiteJobUrl(orgSlug, pipelineSlug, buildNumber, args.jobId);
    }

    try {
      const errorPayload = await fetchErrorPayload({
        orgSlug,
        pipelineSlug,
        buildNumber,
        bkciPath,
        testName: args.errorFor,
        jobId: args.jobId,
        jobUrl: resolvedJobUrl,
        failedLineRow: args.failedLineRow,
      });
      const output = {
        ...errorPayload,
        build: buildInfo,
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    } catch (error) {
      console.error(`Failed to fetch error details: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  let build;
  try {
    build = await fetchBuild({
      orgSlug,
      pipelineSlug,
      buildNumber,
      bkciPath,
    });
  } catch (error) {
    console.error(`Failed to fetch build: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const buildInfo = extractBuildInfo(build, buildNumber);

  let allPlaywrightJobs;
  try {
    allPlaywrightJobs = selectPlaywrightJobs(build);
  } catch (error) {
    console.error(`Failed to parse build response: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const jobStates = buildJobStates(allPlaywrightJobs);
  const cachePath = buildCachePath({
    orgSlug,
    pipelineSlug,
    buildNumber,
    bkciPath,
  });

  const cached = await loadCache(cachePath);
  if (cached && isCacheValid(cached, { orgSlug, pipelineSlug, buildNumber, bkciPath, jobStates })) {
    const payload = {
      ...cached.payload,
      build: cached.payload.build ?? buildInfo,
      meta: {
        cached: true,
        cachePath,
        cachedAt: cached.meta.cachedAt,
        checkedAt: new Date().toISOString(),
      },
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const jobs = filterFailedPlaywrightJobs(allPlaywrightJobs);
  const jobResults = [];

  for (const job of jobs) {
    let logContent;
    try {
      logContent = await fetchJobLog({
        orgSlug,
        pipelineSlug,
        buildNumber,
        jobId: job.id,
        bkciPath,
      });
    } catch (error) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl || getBuildkiteJobUrl(orgSlug, pipelineSlug, buildNumber, job.id),
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: `Failed to fetch log: ${error.message}`,
      });
      continue;
    }

    const lines = splitLogContent(logContent);
    const { failedLine, failedLineRow, tests, testEntries } = extractFailedTests(lines);

    if (failedLineRow === null) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl || getBuildkiteJobUrl(orgSlug, pipelineSlug, buildNumber, job.id),
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: "No failed summary line found in job log.",
      });
      continue;
    }

    jobResults.push({
      jobName: job.name,
      jobId: job.id,
      jobUrl: job.jobUrl || getBuildkiteJobUrl(orgSlug, pipelineSlug, buildNumber, job.id),
      label: normalizeJobLabel(job.name),
      state: job.state,
      failedLine,
      failedLineRow,
      tests,
      testEntries,
      error: null,
    });
  }

  const summary = buildSummaryData(jobResults);
  const cachedAt = new Date().toISOString();
  const payload = {
    build: buildInfo,
    summary,
    jobs: jobResults,
    meta: {
      cached: false,
      cachePath,
      cachedAt,
      checkedAt: cachedAt,
    },
  };

  await writeCache(cachePath, {
    version: CACHE_VERSION,
    meta: {
      orgSlug,
      pipelineSlug,
      buildNumber,
      bkciPath,
      cachedAt,
      jobStates,
    },
    payload: {
      build: buildInfo,
      summary,
      jobs: jobResults,
    },
  });

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(`Unexpected failure: ${error.message}`);
  process.exitCode = 1;
});
