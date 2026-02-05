#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_PATTERN = String.raw`\b\d+ failed\b`;
const DEFAULT_SEARCH_LIMIT = 80;
const DEFAULT_CONTEXT = 3;
const DEFAULT_READ_LIMIT = 120;
const DEFAULT_ERROR_SEARCH_LIMIT = 20;
const DEFAULT_ERROR_CONTEXT = 2;
const DEFAULT_ERROR_READ_LIMIT = 200;
const DEFAULT_SERVER = "buildkite-remote";
const CACHE_VERSION = 4;
const CACHE_DIR = path.join(os.tmpdir(), "pi-buildkite-playwright-failures");

const USAGE = `Usage:
  ./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER
  ./scripts/extract-playwright-failures.cjs --org ORG --pipeline PIPELINE --build BUILD_NUMBER --error-for "TEST_NAME" --job-id JOB_ID [--job-url URL] [--failed-line-row N]

Options:
  --server NAME              MCP server name (default: ${DEFAULT_SERVER})
  --pattern REGEX            Regex for the failed summary line (default: ${DEFAULT_PATTERN})
  --search-limit N           Max matches to return from search_logs (default: ${DEFAULT_SEARCH_LIMIT})
  --context N                Context lines around the summary search match (default: ${DEFAULT_CONTEXT})
  --read-limit N             Lines to read from read_logs (default: ${DEFAULT_READ_LIMIT})
  --error-for TEST_NAME      Fetch error details for a single test (requires --job-id)
  --job-id ID                Buildkite job id for error lookup
  --job-url URL              Buildkite job URL for log links (optional)
  --failed-line-row N        Row number of the summary block (optional)
  --error-search-limit N     Max matches to return for error search (default: ${DEFAULT_ERROR_SEARCH_LIMIT})
  --error-context N          Context lines around the error match (default: ${DEFAULT_ERROR_CONTEXT})
  --error-read-limit N       Lines to read around the error match (default: ${DEFAULT_ERROR_READ_LIMIT})
  -h, --help                 Show this help
`;

function parseArgs(argv) {
  const args = {
    server: DEFAULT_SERVER,
    pattern: DEFAULT_PATTERN,
    searchLimit: DEFAULT_SEARCH_LIMIT,
    context: DEFAULT_CONTEXT,
    readLimit: DEFAULT_READ_LIMIT,
    errorSearchLimit: DEFAULT_ERROR_SEARCH_LIMIT,
    errorContext: DEFAULT_ERROR_CONTEXT,
    errorReadLimit: DEFAULT_ERROR_READ_LIMIT,
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
      case "--server":
        args.server = next;
        i += 1;
        break;
      case "--build":
      case "--build-number":
        args.build = next;
        i += 1;
        break;
      case "--pattern":
        args.pattern = next;
        i += 1;
        break;
      case "--search-limit":
        args.searchLimit = toNumberOption("--search-limit", next);
        i += 1;
        break;
      case "--context":
        args.context = toNumberOption("--context", next);
        i += 1;
        break;
      case "--read-limit":
        args.readLimit = toNumberOption("--read-limit", next);
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
      case "--error-search-limit":
        args.errorSearchLimit = toNumberOption("--error-search-limit", next);
        i += 1;
        break;
      case "--error-context":
        args.errorContext = toNumberOption("--error-context", next);
        i += 1;
        break;
      case "--error-read-limit":
        args.errorReadLimit = toNumberOption("--error-read-limit", next);
        i += 1;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  return args;
}

function toNumberOption(label, value) {
  if (!value) {
    throw new Error(`missing value for ${label}`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`invalid ${label}: ${value}`);
  }
  return parsed;
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

function buildCachePath({ orgSlug, pipelineSlug, buildNumber, serverName }) {
  const safe = [serverName, orgSlug, pipelineSlug, buildNumber].map(sanitizeKey).join("__");
  return path.join(CACHE_DIR, `${safe}.json`);
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

function isCacheValid(cacheData, { orgSlug, pipelineSlug, buildNumber, serverName, jobStates }) {
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
  if (meta.serverName !== serverName) {
    return false;
  }
  if (!meta.jobStates) {
    return false;
  }
  return areJobStatesEqual(meta.jobStates, jobStates);
}

function escapeForFunctionString(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function buildkiteCallExpression({ server, tool, args }) {
  const serializedArgs = Object.entries(args)
    .map(([key, value]) => `${key}: ${serializeArg(value)}`)
    .join(", ");
  return `${server}.${tool}(${serializedArgs})`;
}

function serializeArg(value) {
  if (typeof value === "string") {
    return `"${escapeForFunctionString(value)}"`;
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  throw new Error(`unsupported arg type: ${typeof value}`);
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

function findFailedSummaryRow(searchResults) {
  const results = Array.isArray(searchResults?.results) ? searchResults.results : [];
  for (const result of results) {
    const content = stripAnsi(result?.match?.content ?? "");
    if (/\b\d+\s+failed\b/i.test(content)) {
      return result.match?.row_number ?? null;
    }
  }
  return null;
}

function normalizeLogLine(text) {
  return stripAnsi(text ?? "").trim();
}

function normalizeLogLinePreserveIndent(text) {
  return stripAnsi(text ?? "").replace(/\r$/, "").trimEnd();
}

function buildLogEntries(entries, startRow, preserveIndent) {
  return (entries ?? []).map((entry, index) => {
    const row = typeof entry?.r === "number"
      ? entry.r
      : typeof entry?.row === "number"
        ? entry.row
        : (startRow ?? 0) + index;
    const text = preserveIndent
      ? normalizeLogLinePreserveIndent(entry?.c ?? "")
      : normalizeLogLine(entry?.c ?? "");
    return { text, row };
  });
}

function extractFailedTests(entries, startRow) {
  const lines = buildLogEntries(entries, startRow, false);
  const failedLineIndex = lines.findIndex((line) => /\b\d+\s+failed\b/i.test(line.text));
  if (failedLineIndex === -1) {
    return { failedLine: null, failedLineRow: null, tests: [], testEntries: [] };
  }

  const failedLine = lines[failedLineIndex].text;
  const failedLineRow = lines[failedLineIndex].row;
  const tests = [];
  const testEntries = [];

  for (let i = failedLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.text) {
      continue;
    }
    if (/\b\d+\s+(flaky|skipped|passed)\b/i.test(line.text)) {
      break;
    }
    tests.push(line.text);
    testEntries.push({ name: line.text, row: line.row });
  }

  return { failedLine, failedLineRow, tests, testEntries };
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildTestSearchPattern(testName) {
  return escapeRegex(testName);
}

function findTestMatchRow(searchResults, failedLineRow) {
  const results = Array.isArray(searchResults?.results) ? searchResults.results : [];
  const rows = results
    .map((result) => result?.match?.row_number)
    .filter((row) => typeof row === "number");
  const filtered = failedLineRow === null || failedLineRow === undefined
    ? rows
    : rows.filter((row) => row < failedLineRow);
  if (filtered.length === 0) {
    return null;
  }
  return Math.max(...filtered);
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

function extractErrorBlock(entries, startRow, matchRow, testName) {
  const lines = buildLogEntries(entries, startRow, true);
  let startIndex = lines.findIndex((line) => line.row === matchRow);
  if (startIndex === -1) {
    startIndex = lines.findIndex((line) => line.text.includes(testName));
  }
  if (startIndex === -1) {
    return { startRow: null, endRow: null, lines: [] };
  }

  const output = [];
  for (let i = startIndex; i < lines.length; i += 1) {
    const line = lines[i];
    if (i > startIndex) {
      if (isTestHeaderLine(line.text) || isSummarySectionLine(line.text) || isRetryLine(line.text)) {
        break;
      }
    }
    output.push(line);
  }

  while (output.length > 0 && output[output.length - 1].text.trim() === "") {
    output.pop();
  }

  const startRowValue = output[0]?.row ?? null;
  const endRowValue = output[output.length - 1]?.row ?? null;
  return {
    startRow: startRowValue,
    endRow: endRowValue,
    lines: output.map((line) => line.text),
  };
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
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

function extractErrorMessage(result) {
  if (!result || typeof result !== "object") {
    return "unknown error";
  }
  if (Array.isArray(result.content)) {
    const textEntry = result.content.find((entry) => entry?.type === "text");
    if (textEntry?.text) {
      return textEntry.text;
    }
  }
  if (typeof result.error === "string") {
    return result.error;
  }
  return "unknown error";
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

async function mcporterCall(server, tool, args) {
  const expression = buildkiteCallExpression({ server, tool, args });
  const { stdout, stderr } = await execFileAsync(
    "mcporter",
    ["call", expression, "--output", "json"],
    { maxBuffer: 1024 * 1024 * 10 }
  );

  if (stderr?.trim()) {
    process.stderr.write(stderr);
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`failed to parse mcporter output: ${error.message}`);
  }
}

async function fetchBuild({ orgSlug, pipelineSlug, buildNumber, serverName }) {
  let build;
  try {
    build = await mcporterCall(serverName, "get_build", {
      org_slug: orgSlug,
      pipeline_slug: pipelineSlug,
      build_number: buildNumber,
      detail_level: "full",
    });
  } catch (error) {
    throw new Error(error.message);
  }

  if (build?.isError) {
    throw new Error(extractErrorMessage(build));
  }

  return build;
}

async function fetchErrorPayload({
  orgSlug,
  pipelineSlug,
  buildNumber,
  serverName,
  testName,
  jobId,
  jobUrl,
  failedLineRow,
  searchLimit,
  context,
  readLimit,
}) {
  const pattern = buildTestSearchPattern(testName);
  let searchResults;
  try {
    searchResults = await mcporterCall(serverName, "search_logs", {
      org_slug: orgSlug,
      pipeline_slug: pipelineSlug,
      build_number: buildNumber,
      job_id: jobId,
      pattern,
      reverse: true,
      limit: searchLimit,
      context,
    });
  } catch (error) {
    throw new Error(`failed to search logs: ${error.message}`);
  }

  if (searchResults?.isError) {
    throw new Error(`failed to search logs: ${extractErrorMessage(searchResults)}`);
  }

  const matchRow = findTestMatchRow(searchResults, failedLineRow ?? null);
  if (matchRow === null) {
    throw new Error("no matching log entry found for test");
  }

  const seekRow = Math.max(matchRow - context, 0);
  let logSlice;
  try {
    logSlice = await mcporterCall(serverName, "read_logs", {
      org_slug: orgSlug,
      pipeline_slug: pipelineSlug,
      build_number: buildNumber,
      job_id: jobId,
      seek: seekRow,
      limit: readLimit,
    });
  } catch (error) {
    throw new Error(`failed to read logs: ${error.message}`);
  }

  if (logSlice?.isError) {
    throw new Error(`failed to read logs: ${extractErrorMessage(logSlice)}`);
  }

  const errorBlock = extractErrorBlock(logSlice?.entries ?? [], seekRow, matchRow, testName);
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
  const serverName = args.server;

  if (args.errorFor) {
    let buildInfo = null;
    try {
      const build = await fetchBuild({
        orgSlug,
        pipelineSlug,
        buildNumber,
        serverName,
      });
      buildInfo = extractBuildInfo(build, buildNumber);
    } catch {
      buildInfo = null;
    }

    try {
      const errorPayload = await fetchErrorPayload({
        orgSlug,
        pipelineSlug,
        buildNumber,
        serverName,
        testName: args.errorFor,
        jobId: args.jobId,
        jobUrl: args.jobUrl,
        failedLineRow: args.failedLineRow,
        searchLimit: args.errorSearchLimit,
        context: args.errorContext,
        readLimit: args.errorReadLimit,
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
      serverName,
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
    serverName,
  });
  const cached = await loadCache(cachePath);
  if (cached && isCacheValid(cached, { orgSlug, pipelineSlug, buildNumber, serverName, jobStates })) {
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
    let searchResults;
    try {
      searchResults = await mcporterCall(serverName, "search_logs", {
        org_slug: orgSlug,
        pipeline_slug: pipelineSlug,
        build_number: buildNumber,
        job_id: job.id,
        pattern: args.pattern,
        reverse: true,
        limit: args.searchLimit,
        context: args.context,
      });
    } catch (error) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl,
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: `Failed to search logs: ${error.message}`,
      });
      continue;
    }

    if (searchResults?.isError) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl,
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: `Failed to search logs: ${extractErrorMessage(searchResults)}`,
      });
      continue;
    }

    const summaryRow = findFailedSummaryRow(searchResults);
    if (summaryRow === null) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl,
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: "No failed summary line found in search results.",
      });
      continue;
    }

    const seekRow = Math.max(summaryRow - 3, 0);
    let logSlice;
    try {
      logSlice = await mcporterCall(serverName, "read_logs", {
        org_slug: orgSlug,
        pipeline_slug: pipelineSlug,
        build_number: buildNumber,
        job_id: job.id,
        seek: seekRow,
        limit: args.readLimit,
      });
    } catch (error) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl,
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: `Failed to read logs: ${error.message}`,
      });
      continue;
    }

    if (logSlice?.isError) {
      jobResults.push({
        jobName: job.name,
        jobId: job.id,
        jobUrl: job.jobUrl,
        label: normalizeJobLabel(job.name),
        state: job.state,
        failedLine: null,
        failedLineRow: null,
        tests: [],
        testEntries: [],
        error: `Failed to read logs: ${extractErrorMessage(logSlice)}`,
      });
      continue;
    }

    const { failedLine, failedLineRow, tests, testEntries } = extractFailedTests(
      logSlice?.entries ?? [],
      seekRow
    );
    jobResults.push({
      jobName: job.name,
      jobId: job.id,
      jobUrl: job.jobUrl,
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
      serverName,
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
  return;
}

main().catch((error) => {
  console.error(`Unexpected failure: ${error.message}`);
  process.exitCode = 1;
});
