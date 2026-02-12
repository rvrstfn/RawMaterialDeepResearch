#!/usr/bin/env node
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const OpenAI = require("openai");
const { z } = require("zod");
const {
  Agent,
  run,
  tool,
  OpenAIConversationsSession,
  startOpenAIConversationsSession,
} = require("@openai/agents");
const { AuthStore, SESSION_TTL_MS } = require("./auth-store");

// Load local `.env` if present so the server can be started from tmux/systemd/etc.
// We only set keys that are not already present in `process.env`.
function loadDotEnvIfPresent() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith("\"") && val.endsWith("\"")) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  } catch {
    // Ignore `.env` parse failures; env may be provided externally.
  }
}

loadDotEnvIfPresent();

const PORT = Number(process.env.PORT || 8788);
const DEFAULT_MODEL_FALLBACK = process.env.DEFAULT_MODEL || "gpt-5-mini";
// Opt-in to model-provided reasoning summaries (not raw chain-of-thought).
// Set `REASONING_SUMMARY=off` to disable.
const REASONING_SUMMARY = String(process.env.REASONING_SUMMARY || "auto").trim().toLowerCase();
const REASONING_EFFORT_DEFAULT = String(process.env.REASONING_EFFORT || "low").trim().toLowerCase();
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 10 * 60 * 1000);
const MAX_TURNS_DEFAULT = Number(process.env.MAX_TURNS || 25);
const CONTEXT_COMPACTION_ENABLED_DEFAULT = String(
  process.env.CONTEXT_COMPACTION_ENABLED == null ? "1" : process.env.CONTEXT_COMPACTION_ENABLED
).trim().toLowerCase();
const CONTEXT_COMPACTION_THRESHOLD_DEFAULT = Number(process.env.CONTEXT_COMPACTION_THRESHOLD || 160000);
const PUBLIC_DIR = path.join(__dirname, "public");
const CONVERSATIONS_DIR = path.join(__dirname, "conversations");
const TURN_LOGS_DIR = path.join(__dirname, "logs", "turns");
const CHAT_LOGS_DIR = path.join(__dirname, "logs", "chats");
const THREAD_META_PATH = path.join(__dirname, ".thread-meta.json");
const APP_SETTINGS_PATH = path.join(__dirname, ".app-settings.json");
const SESSION_COOKIE_NAME = "codexgui_session";
const ALLOWED_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const DEFAULT_STANDARD_PRICING_PER_1M = {
  // Source (standard processing): https://openai.com/api/pricing/
  // gpt-5.2: input $1.75, cached input $0.175, output $14.00 per 1M tokens.
  "gpt-5.2": { input: 1.75, cachedInput: 0.175, output: 14.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-5.2-pro": { input: 21.0, cachedInput: 0, output: 168.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-5": { input: 1.25, cachedInput: 0.125, output: 10.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-5-mini": { input: 0.25, cachedInput: 0.025, output: 2.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-5-nano": { input: 0.05, cachedInput: 0.005, output: 0.4, source: "openai_standard_pricing_2026-02-11" },
  "gpt-4.1": { input: 2.0, cachedInput: 0.5, output: 8.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-4.1-mini": { input: 0.4, cachedInput: 0.1, output: 1.6, source: "openai_standard_pricing_2026-02-11" },
  "gpt-4.1-nano": { input: 0.1, cachedInput: 0.025, output: 0.4, source: "openai_standard_pricing_2026-02-11" },
  "gpt-4o": { input: 2.5, cachedInput: 1.25, output: 10.0, source: "openai_standard_pricing_2026-02-11" },
  "gpt-4o-mini": { input: 0.15, cachedInput: 0.075, output: 0.6, source: "openai_standard_pricing_2026-02-11" },
};

const SERVER_STARTED_AT = new Date().toISOString();
const PACKAGE_VERSION = (() => {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const pkg = require("./package.json");
    return pkg && typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

function getGitInfo() {
  try {
    const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
    });
    const out = sha && typeof sha.stdout === "string" ? sha.stdout.trim() : "";
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: __dirname,
      encoding: "utf8",
    });
    const dirty = !!(status && typeof status.stdout === "string" && status.stdout.trim());
    return { sha: out || null, dirty };
  } catch {
    return { sha: null, dirty: false };
  }
}

function safeStat(filePath) {
  try {
    const st = fs.statSync(filePath);
    return { mtimeMs: st.mtimeMs, mtime: st.mtime.toISOString(), size: st.size };
  } catch {
    return null;
  }
}

function getBuildInfo() {
  const files = {
    serverJs: safeStat(path.join(__dirname, "server.js")),
    packageJson: safeStat(path.join(__dirname, "package.json")),
    indexHtml: safeStat(path.join(__dirname, "public", "index.html")),
    loginHtml: safeStat(path.join(__dirname, "public", "login.html")),
    adminHtml: safeStat(path.join(__dirname, "public", "admin.html")),
    testHtml: safeStat(path.join(__dirname, "public", "test.html")),
  };

  // Build id changes whenever any of these files changes. This lets you confirm
  // you're looking at the latest UI/backend without relying on git or restarts.
  const hash = crypto
    .createHash("sha1")
    .update(JSON.stringify(files))
    .digest("hex")
    .slice(0, 10);

  const latestMtimeMs = Object.values(files)
    .filter(Boolean)
    .reduce((acc, v) => Math.max(acc, v.mtimeMs || 0), 0);

  return { id: hash, latestMtimeMs, files };
}

const DEFAULT_THREAD_PREAMBLE_FALLBACK = `This is a deep research job.

The folder ../ingredients contains TXT exports of many documents related to cosmetics raw materials.

I need you to search for all raw materials that answer the user query.

Consider that:
- Documents can be both English and Korean.
- Many docs were extracted from PDFs, so words can be split across lines.

Do not rely on extraction only. Use your own reasoning to review findings and improve the research quality.

Below is the user query.`;

const authStore = new AuthStore();

function parseCookies(req) {
  const out = {};
  const raw = req.headers && req.headers.cookie ? String(req.headers.cookie) : "";
  if (!raw) return out;
  const pairs = raw.split(";");
  for (const p of pairs) {
    const idx = p.indexOf("=");
    if (idx <= 0) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function getSessionFromReq(req) {
  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE_NAME] || "";
  if (!token) return null;
  return authStore.getSession(token);
}

function setSessionCookie(res, token) {
  const value = `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  res.setHeader("Set-Cookie", value);
}

function clearSessionCookie(res) {
  const value = `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  res.setHeader("Set-Cookie", value);
}

function toJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 8 * 1024 * 1024) {
        req.destroy();
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function safeNowFolderName() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function loadJsonObject(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function windowsPathToWsl(rawPath) {
  if (typeof rawPath !== "string") return "";
  const trimmed = rawPath.trim();
  const m = /^([a-zA-Z]):[\\/](.*)$/.exec(trimmed);
  if (!m) return trimmed;
  const drive = m[1].toLowerCase();
  const rest = m[2].replace(/\\/g, "/");
  return `/mnt/${drive}/${rest}`;
}

function resolveIngredientsDir() {
  const fromEnv = [
    process.env.INGREDIENTS_DIR,
    process.env.INGREDIENTS_WINDOWS_DIR,
    process.env.SHARED_READONLY_DIR,
  ].find((v) => typeof v === "string" && v.trim());

  const fallbackWindows = "D:\\Ingredient\\PDFs\\txt";
  const candidate = fromEnv ? fromEnv.trim() : fallbackWindows;
  const wslPath = windowsPathToWsl(candidate);

  if (path.isAbsolute(wslPath)) return wslPath;
  return path.resolve(__dirname, wslPath);
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function toSafeRelPath(ingredientsRoot, candidate) {
  const rel = String(candidate || "").replace(/\\/g, "/").trim();
  if (!rel) throw new Error("relativePath is required");
  const full = path.resolve(ingredientsRoot, rel);
  const root = path.resolve(ingredientsRoot) + path.sep;
  if (!(full + path.sep).startsWith(root) && full !== path.resolve(ingredientsRoot)) {
    throw new Error("Path escapes ingredient root");
  }
  return full;
}

function listTextFiles(rootDir, limit = 2000) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  const stack = [rootDir];

  while (stack.length && out.length < limit) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (out.length >= limit) break;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (lower.endsWith(".txt")) out.push(full);
    }
  }

  return out;
}

function parseRgMatches(stdout, maxMatches) {
  const lines = String(stdout || "").split(/\r?\n/).filter(Boolean);
  const hits = [];
  for (const line of lines) {
    if (hits.length >= maxMatches) break;
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    hits.push({
      file: m[1],
      line: Number(m[2]),
      text: m[3],
    });
  }
  return hits;
}

function getPricingTable() {
  const raw = typeof process.env.OPENAI_PRICING_PER_1M_JSON === "string"
    ? process.env.OPENAI_PRICING_PER_1M_JSON.trim()
    : "";
  if (!raw) return DEFAULT_STANDARD_PRICING_PER_1M;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_STANDARD_PRICING_PER_1M;
    return { ...DEFAULT_STANDARD_PRICING_PER_1M, ...parsed };
  } catch {
    return DEFAULT_STANDARD_PRICING_PER_1M;
  }
}

function pickPricingForModel(model) {
  const table = getPricingTable();
  const m = String(model || "").trim().toLowerCase();
  if (!m) return null;
  if (table[m]) return { key: m, ...table[m] };
  for (const key of Object.keys(table)) {
    if (m.startsWith(`${key.toLowerCase()}-`)) return { key, ...table[key] };
  }
  return null;
}

function estimateCostUsd({ model, inputTokens, cachedTokens, outputTokens }) {
  const price = pickPricingForModel(model);
  if (!price) return { estimatedCostUsd: 0, pricingModelKey: "", pricingSource: "" };

  const input = Number(inputTokens || 0);
  const cached = Number(cachedTokens || 0);
  const output = Number(outputTokens || 0);
  const per1mInput = Number(price.input || 0);
  const per1mCached = Number(price.cachedInput || 0);
  const per1mOutput = Number(price.output || 0);

  const cost = (input / 1_000_000) * per1mInput +
    (cached / 1_000_000) * per1mCached +
    (output / 1_000_000) * per1mOutput;

  return {
    estimatedCostUsd: Number.isFinite(cost) ? Number(cost.toFixed(8)) : 0,
    pricingModelKey: String(price.key || ""),
    pricingSource: String(price.source || ""),
  };
}

function toIsoNow() {
  return new Date().toISOString();
}

function createTurnLogFiles({
  turnId,
  threadId,
  conversationDir,
  model,
  maxTurns,
  userQuery,
  compactionEnabled,
  compactionThreshold,
}) {
  ensureDirSync(TURN_LOGS_DIR);
  ensureDirSync(CHAT_LOGS_DIR);
  const stamp = safeNowFolderName();
  const baseName = `${stamp}_${turnId}`;
  const mdPath = path.join(TURN_LOGS_DIR, `${baseName}.md`);
  const jsonPath = path.join(TURN_LOGS_DIR, `${baseName}.json`);
  const safeThreadId = String(threadId || "").replace(/[^a-zA-Z0-9._-]/g, "_");
  const chatMdPath = path.join(CHAT_LOGS_DIR, `${safeThreadId}.md`);
  const chatJsonPath = path.join(CHAT_LOGS_DIR, `${safeThreadId}.json`);

  const data = {
    queryId: turnId,
    runId: "",
    turnIndex: null,
    turnId,
    threadId,
    model,
    reasoningEffort: "",
    maxOutputTokens: 0,
    maxTurns,
    userQuery: String(userQuery || ""),
    systemPrompt: "",
    conversationDir: conversationDir || "",
    startedAt: toIsoNow(),
    finishedAt: "",
    status: "running",
    turnsUsed: null,
    finalAnswer: "",
    error: "",
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    toolCallsCount: 0,
    grepHitsInjected: 0,
    grepCharsInjected: 0,
    compactionEnabled: Boolean(compactionEnabled),
    compactionTriggered: false,
    compactionThreshold: Number.isFinite(Number(compactionThreshold)) ? Number(compactionThreshold) : 0,
    stoppedByMaxTurns: false,
    finalizerUsed: false,
    estimatedCostUsd: 0,
    pricingModelKey: "",
    pricingSource: "",
    cliCommands: [],
    reasoningTrace: [],
  };

  const save = () => {
    try {
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // ignore
    }

    const lines = [];
    lines.push(`# Agent Turn Log`);
    lines.push("");
    lines.push(`- Query ID: ${data.queryId}`);
    lines.push(`- Run ID: ${data.runId || "(unknown)"}`);
    if (typeof data.turnIndex === "number") lines.push(`- Turn Index: ${data.turnIndex}`);
    lines.push(`- Turn ID: ${data.turnId}`);
    lines.push(`- Thread ID: ${data.threadId}`);
    lines.push(`- Model: ${data.model}`);
    if (data.reasoningEffort) lines.push(`- Reasoning Effort: ${data.reasoningEffort}`);
    lines.push(`- Max Output Tokens: ${data.maxOutputTokens}`);
    lines.push(`- Max Turns: ${data.maxTurns}`);
    if (typeof data.turnsUsed === "number") lines.push(`- Turns Used: ${data.turnsUsed}`);
    lines.push(`- Status: ${data.status}`);
    lines.push(`- Input Tokens: ${data.inputTokens}`);
    lines.push(`- Cached Tokens: ${data.cachedTokens}`);
    lines.push(`- Output Tokens: ${data.outputTokens}`);
    lines.push(`- Reasoning Tokens: ${data.reasoningTokens}`);
    lines.push(`- Total Tokens: ${data.totalTokens}`);
    lines.push(`- Tool Calls Count: ${data.toolCallsCount}`);
    lines.push(`- Grep Hits Injected: ${data.grepHitsInjected}`);
    lines.push(`- Grep Chars Injected: ${data.grepCharsInjected}`);
    lines.push(`- Compaction Enabled: ${data.compactionEnabled}`);
    lines.push(`- Compaction Triggered: ${data.compactionTriggered}`);
    if (Number.isFinite(Number(data.compactionThreshold)) && Number(data.compactionThreshold) > 0) {
      lines.push(`- Compaction Threshold: ${Number(data.compactionThreshold)}`);
    }
    lines.push(`- Stopped By Max Turns: ${data.stoppedByMaxTurns}`);
    lines.push(`- Finalizer Used: ${data.finalizerUsed}`);
    lines.push(`- Estimated Cost USD: ${data.estimatedCostUsd}`);
    if (data.pricingModelKey) lines.push(`- Pricing Model Key: ${data.pricingModelKey}`);
    if (data.pricingSource) lines.push(`- Pricing Source: ${data.pricingSource}`);
    lines.push(`- Started At: ${data.startedAt}`);
    if (data.finishedAt) lines.push(`- Finished At: ${data.finishedAt}`);
    if (data.conversationDir) lines.push(`- Conversation Dir: ${data.conversationDir}`);
    lines.push("");
    lines.push(`## User Query`);
    lines.push("");
    lines.push(data.userQuery || "(empty)");
    lines.push("");
    lines.push(`## System Prompt`);
    lines.push("");
    lines.push(data.systemPrompt || "(empty)");
    lines.push("");
    lines.push(`## CLI Commands`);
    lines.push("");
    if (!data.cliCommands.length) {
      lines.push(`(no CLI command was called by tools in this turn)`);
    } else {
      for (const cmd of data.cliCommands) {
        const args = Array.isArray(cmd.args) ? cmd.args.join(" ") : "";
        const cmdLine = cmd.command ? `${cmd.command} ${args}`.trim() : "";
        lines.push(`- [${cmd.ts || ""}] \`${cmdLine}\``);
        if (cmd.cwd) lines.push(`  - cwd: ${cmd.cwd}`);
        if (typeof cmd.exitCode === "number") lines.push(`  - exitCode: ${cmd.exitCode}`);
        if (cmd.error) lines.push(`  - error: ${cmd.error}`);
        if (cmd.stderr) lines.push(`  - stderr: ${cmd.stderr}`);
      }
    }
    lines.push("");
    lines.push(`## Reasoning Trace (Summary Events)`);
    lines.push("");
    if (!data.reasoningTrace.length) {
      lines.push(`(no reasoning summary events captured)`);
    } else {
      for (const ev of data.reasoningTrace) {
        const bits = [ev.ts ? `[${ev.ts}]` : "", ev.kind || ""].filter(Boolean).join(" ");
        if (ev.text) lines.push(`- ${bits}: ${ev.text}`);
        else if (ev.delta) lines.push(`- ${bits}: ${ev.delta}`);
        else lines.push(`- ${bits}`);
      }
    }
    lines.push("");
    lines.push(`## Final Answer`);
    lines.push("");
    lines.push(data.finalAnswer || "(empty)");
    if (data.error) {
      lines.push("");
      lines.push(`## Error`);
      lines.push("");
      lines.push(data.error);
    }
    lines.push("");

    try {
      fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
    } catch {
      // ignore
    }
  };

  return {
    mdPath,
    jsonPath,
    chatMdPath,
    chatJsonPath,
    recordCliCommand(entry) {
      if (!entry || typeof entry !== "object") return;
      data.cliCommands.push({ ts: toIsoNow(), ...entry });
      save();
    },
    recordReasoning(entry) {
      if (!entry || typeof entry !== "object") return;
      data.reasoningTrace.push({ ts: toIsoNow(), ...entry });
      if (data.reasoningTrace.length > 2000) data.reasoningTrace = data.reasoningTrace.slice(-2000);
      save();
    },
    setRunInfo(entry) {
      if (!entry || typeof entry !== "object") return;
      if (typeof entry.runId === "string" && entry.runId) data.runId = entry.runId;
      if (typeof entry.reasoningEffort === "string" && entry.reasoningEffort) data.reasoningEffort = entry.reasoningEffort;
      if (Number.isFinite(Number(entry.maxOutputTokens))) data.maxOutputTokens = Number(entry.maxOutputTokens);
      if (typeof entry.systemPrompt === "string") data.systemPrompt = entry.systemPrompt;
      save();
    },
    recordUsage(entry) {
      if (!entry || typeof entry !== "object") return;
      if (Number.isFinite(Number(entry.inputTokens))) data.inputTokens = Number(entry.inputTokens);
      if (Number.isFinite(Number(entry.cachedTokens))) data.cachedTokens = Number(entry.cachedTokens);
      if (Number.isFinite(Number(entry.outputTokens))) data.outputTokens = Number(entry.outputTokens);
      if (Number.isFinite(Number(entry.reasoningTokens))) data.reasoningTokens = Number(entry.reasoningTokens);
      if (Number.isFinite(Number(entry.totalTokens))) data.totalTokens = Number(entry.totalTokens);
      save();
    },
    recordToolCall(entry) {
      data.toolCallsCount += 1;
      if (entry && typeof entry === "object") {
        if (Number.isFinite(Number(entry.grepHitsInjected))) data.grepHitsInjected += Number(entry.grepHitsInjected);
        if (Number.isFinite(Number(entry.grepCharsInjected))) data.grepCharsInjected += Number(entry.grepCharsInjected);
      }
      save();
    },
    markCompactionTriggered() {
      data.compactionTriggered = true;
      save();
    },
    finalize({ status, turnsUsed, finalAnswer, error }) {
      data.status = status || data.status;
      data.finishedAt = toIsoNow();
      if (typeof turnsUsed === "number" && Number.isFinite(turnsUsed)) data.turnsUsed = turnsUsed;
      data.finalAnswer = typeof finalAnswer === "string" ? finalAnswer : data.finalAnswer;
      data.error = typeof error === "string" ? error : "";
      data.stoppedByMaxTurns = Boolean(
        (typeof data.error === "string" && /max[_\s-]*turns?/i.test(data.error)) ||
        (typeof data.turnsUsed === "number" && typeof data.maxTurns === "number" && data.turnsUsed >= data.maxTurns)
      );
      if (!data.totalTokens) {
        data.totalTokens = (data.inputTokens || 0) + (data.outputTokens || 0) + (data.reasoningTokens || 0);
      }
      // Fallback estimation when usage is unavailable from provider events.
      // Heuristic: ~4 chars/token for mixed English/Korean short text.
      const hasUsage = (data.inputTokens + data.outputTokens + data.reasoningTokens) > 0;
      if (!hasUsage) {
        const queryChars = String(data.userQuery || "").length;
        const answerChars = String(data.finalAnswer || "").length;
        const reasoningChars = Array.isArray(data.reasoningTrace)
          ? data.reasoningTrace.reduce((sum, ev) => sum + String((ev && (ev.text || ev.delta)) || "").length, 0)
          : 0;
        const approxInput = Math.ceil((queryChars + Number(data.grepCharsInjected || 0)) / 4);
        const approxReasoning = Math.ceil(reasoningChars / 4);
        const approxOutput = Math.ceil(answerChars / 4);
        data.inputTokens = Math.max(data.inputTokens, approxInput);
        data.reasoningTokens = Math.max(data.reasoningTokens, approxReasoning);
        data.outputTokens = Math.max(data.outputTokens, approxOutput);
        data.totalTokens = data.inputTokens + data.outputTokens + data.reasoningTokens;
      }
      const pricing = estimateCostUsd({
        model: data.model,
        inputTokens: data.inputTokens,
        cachedTokens: data.cachedTokens,
        outputTokens: data.outputTokens,
      });
      data.estimatedCostUsd = pricing.estimatedCostUsd;
      data.pricingModelKey = pricing.pricingModelKey;
      data.pricingSource = pricing.pricingSource;
      save();
      try {
        upsertChatLogTurn(data);
        save();
      } catch {
        // ignore chat-level logging failures
      }
    },
  };
}

function upsertChatLogTurn(turnData) {
  if (!turnData || typeof turnData !== "object" || !turnData.threadId) return;
  ensureDirSync(CHAT_LOGS_DIR);
  const safeThreadId = String(turnData.threadId).replace(/[^a-zA-Z0-9._-]/g, "_");
  const jsonPath = path.join(CHAT_LOGS_DIR, `${safeThreadId}.json`);
  const mdPath = path.join(CHAT_LOGS_DIR, `${safeThreadId}.md`);

  let current = {
    threadId: turnData.threadId,
    conversationDir: turnData.conversationDir || "",
    createdAt: turnData.startedAt || toIsoNow(),
    updatedAt: toIsoNow(),
    turns: [],
  };
  try {
    const raw = fs.readFileSync(jsonPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      current = {
        ...current,
        ...parsed,
        turns: Array.isArray(parsed.turns) ? parsed.turns : [],
      };
    }
  } catch {
    // new chat log
  }

  const idx = current.turns.findIndex((t) => t && t.turnId === turnData.turnId);
  if (idx >= 0) current.turns[idx] = turnData;
  else current.turns.push(turnData);
  current.updatedAt = toIsoNow();
  if (turnData.conversationDir) current.conversationDir = turnData.conversationDir;

  current.turns.sort((a, b) => {
    const ta = Date.parse(a && a.startedAt ? a.startedAt : "") || 0;
    const tb = Date.parse(b && b.startedAt ? b.startedAt : "") || 0;
    return ta - tb;
  });
  for (let i = 0; i < current.turns.length; i += 1) {
    current.turns[i].turnIndex = i + 1;
  }

  fs.writeFileSync(jsonPath, JSON.stringify(current, null, 2), "utf8");

  const lines = [];
  lines.push(`# Chat Log`);
  lines.push("");
  lines.push(`- Thread ID: ${current.threadId}`);
  if (current.conversationDir) lines.push(`- Conversation Dir: ${current.conversationDir}`);
  lines.push(`- Created At: ${current.createdAt}`);
  lines.push(`- Updated At: ${current.updatedAt}`);
  lines.push(`- Turns: ${current.turns.length}`);
  lines.push("");

  for (const turn of current.turns) {
    lines.push(`## Turn ${turn.turnId}`);
    lines.push("");
    lines.push(`- Query ID: ${turn.queryId || turn.turnId || ""}`);
    lines.push(`- Run ID: ${turn.runId || "(unknown)"}`);
    if (typeof turn.turnIndex === "number") lines.push(`- Turn Index: ${turn.turnIndex}`);
    lines.push(`- Status: ${turn.status || ""}`);
    lines.push(`- Model: ${turn.model || ""}`);
    if (turn.reasoningEffort) lines.push(`- Reasoning Effort: ${turn.reasoningEffort}`);
    lines.push(`- Max Output Tokens: ${Number.isFinite(Number(turn.maxOutputTokens)) ? Number(turn.maxOutputTokens) : 0}`);
    if (typeof turn.maxTurns === "number") lines.push(`- Max Turns: ${turn.maxTurns}`);
    if (typeof turn.turnsUsed === "number") lines.push(`- Turns Used: ${turn.turnsUsed}`);
    lines.push(`- Input Tokens: ${Number.isFinite(Number(turn.inputTokens)) ? Number(turn.inputTokens) : 0}`);
    lines.push(`- Cached Tokens: ${Number.isFinite(Number(turn.cachedTokens)) ? Number(turn.cachedTokens) : 0}`);
    lines.push(`- Output Tokens: ${Number.isFinite(Number(turn.outputTokens)) ? Number(turn.outputTokens) : 0}`);
    lines.push(`- Reasoning Tokens: ${Number.isFinite(Number(turn.reasoningTokens)) ? Number(turn.reasoningTokens) : 0}`);
    lines.push(`- Total Tokens: ${Number.isFinite(Number(turn.totalTokens)) ? Number(turn.totalTokens) : 0}`);
    lines.push(`- Tool Calls Count: ${Number.isFinite(Number(turn.toolCallsCount)) ? Number(turn.toolCallsCount) : 0}`);
    lines.push(`- Grep Hits Injected: ${Number.isFinite(Number(turn.grepHitsInjected)) ? Number(turn.grepHitsInjected) : 0}`);
    lines.push(`- Grep Chars Injected: ${Number.isFinite(Number(turn.grepCharsInjected)) ? Number(turn.grepCharsInjected) : 0}`);
    lines.push(`- Compaction Enabled: ${turn.compactionEnabled !== false}`);
    lines.push(`- Compaction Triggered: ${Boolean(turn.compactionTriggered)}`);
    if (Number.isFinite(Number(turn.compactionThreshold)) && Number(turn.compactionThreshold) > 0) {
      lines.push(`- Compaction Threshold: ${Number(turn.compactionThreshold)}`);
    }
    lines.push(`- Stopped By Max Turns: ${Boolean(turn.stoppedByMaxTurns)}`);
    lines.push(`- Finalizer Used: ${Boolean(turn.finalizerUsed)}`);
    lines.push(`- Estimated Cost USD: ${Number.isFinite(Number(turn.estimatedCostUsd)) ? Number(turn.estimatedCostUsd) : 0}`);
    if (turn.pricingModelKey) lines.push(`- Pricing Model Key: ${turn.pricingModelKey}`);
    if (turn.pricingSource) lines.push(`- Pricing Source: ${turn.pricingSource}`);
    lines.push(`- Started At: ${turn.startedAt || ""}`);
    if (turn.finishedAt) lines.push(`- Finished At: ${turn.finishedAt}`);
    lines.push("");
    lines.push(`### User Query`);
    lines.push("");
    lines.push(turn.userQuery || "(empty)");
    lines.push("");
    lines.push(`### System Prompt`);
    lines.push("");
    lines.push(typeof turn.systemPrompt === "string" && turn.systemPrompt ? turn.systemPrompt : "(empty)");
    lines.push("");
    lines.push(`### CLI Commands`);
    lines.push("");
    if (!Array.isArray(turn.cliCommands) || !turn.cliCommands.length) {
      lines.push(`(no CLI command was called by tools in this turn)`);
    } else {
      for (const cmd of turn.cliCommands) {
        const args = Array.isArray(cmd.args) ? cmd.args.join(" ") : "";
        const cmdLine = cmd.command ? `${cmd.command} ${args}`.trim() : "";
        lines.push(`- [${cmd.ts || ""}] \`${cmdLine}\``);
        if (cmd.cwd) lines.push(`  - cwd: ${cmd.cwd}`);
        if (typeof cmd.exitCode === "number") lines.push(`  - exitCode: ${cmd.exitCode}`);
        if (cmd.error) lines.push(`  - error: ${cmd.error}`);
      }
    }
    lines.push("");
    lines.push(`### Reasoning Trace (Summary Events)`);
    lines.push("");
    if (!Array.isArray(turn.reasoningTrace) || !turn.reasoningTrace.length) {
      lines.push(`(no reasoning summary events captured)`);
    } else {
      for (const ev of turn.reasoningTrace) {
        const bits = [ev.ts ? `[${ev.ts}]` : "", ev.kind || ""].filter(Boolean).join(" ");
        if (ev.text) lines.push(`- ${bits}: ${ev.text}`);
        else if (ev.delta) lines.push(`- ${bits}: ${ev.delta}`);
        else lines.push(`- ${bits}`);
      }
    }
    lines.push("");
    lines.push(`### Final Answer`);
    lines.push("");
    lines.push(turn.finalAnswer || "(empty)");
    if (turn.error) {
      lines.push("");
      lines.push(`### Error`);
      lines.push("");
      lines.push(turn.error);
    }
    lines.push("");
  }

  fs.writeFileSync(mdPath, lines.join("\n"), "utf8");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractTextFromMessageContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") parts.push(part.text);
    else if (typeof part.transcript === "string") parts.push(part.transcript);
  }
  return parts.join("\n").trim();
}

function parseAssistantTextFromRawItem(rawItem) {
  if (!rawItem || typeof rawItem !== "object") return "";
  const content = Array.isArray(rawItem.content) ? rawItem.content : [];
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "output_text" && typeof part.text === "string") parts.push(part.text);
    if (part.type === "refusal" && typeof part.refusal === "string") parts.push(part.refusal);
    if (part.type === "audio" && typeof part.transcript === "string") parts.push(part.transcript);
  }
  return parts.join("\n").trim();
}

function formatFinalOutput(value) {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractResponseIdFromRawEvent(ev) {
  if (!ev || typeof ev !== "object") return "";
  if (typeof ev.response_id === "string" && ev.response_id) return ev.response_id;
  if (typeof ev.responseId === "string" && ev.responseId) return ev.responseId;
  if (ev.response && typeof ev.response === "object" && typeof ev.response.id === "string" && ev.response.id) {
    return ev.response.id;
  }
  return "";
}

class AgentsClient {
  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.threadMeta = loadJsonObject(THREAD_META_PATH);
    this.appSettings = loadJsonObject(APP_SETTINGS_PATH);
    this.sessions = new Map();
    this.activeTurns = new Map();

    this.ingredientsRoot = resolveIngredientsDir();

    ensureDirSync(CONVERSATIONS_DIR);
  }

  getDefaultModel() {
    const configured = this.appSettings && typeof this.appSettings.defaultModel === "string"
      ? this.appSettings.defaultModel.trim()
      : "";
    return configured || DEFAULT_MODEL_FALLBACK;
  }

  getDefaultThreadPreamble() {
    const configured = this.appSettings && typeof this.appSettings.defaultThreadPreamble === "string"
      ? this.appSettings.defaultThreadPreamble.trim()
      : "";
    return configured || DEFAULT_THREAD_PREAMBLE_FALLBACK;
  }

  getReasoningEffort() {
    const configured = this.appSettings && typeof this.appSettings.reasoningEffort === "string"
      ? this.appSettings.reasoningEffort.trim().toLowerCase()
      : "";
    if (ALLOWED_REASONING_EFFORTS.includes(configured)) return configured;
    return ALLOWED_REASONING_EFFORTS.includes(REASONING_EFFORT_DEFAULT) ? REASONING_EFFORT_DEFAULT : "low";
  }

  getMaxTurns() {
    const configured = this.appSettings ? Number(this.appSettings.maxTurns) : NaN;
    if (Number.isFinite(configured)) return clampNumber(configured, 1, 100, 25);
    if (Number.isFinite(MAX_TURNS_DEFAULT)) return clampNumber(MAX_TURNS_DEFAULT, 1, 100, 25);
    return 25;
  }

  getCompactionEnabled() {
    const configured = this.appSettings && Object.prototype.hasOwnProperty.call(this.appSettings, "compactionEnabled")
      ? this.appSettings.compactionEnabled
      : undefined;
    if (typeof configured === "boolean") return configured;
    if (typeof configured === "string") {
      const v = configured.trim().toLowerCase();
      return !(v === "0" || v === "false" || v === "off" || v === "no");
    }
    return !(CONTEXT_COMPACTION_ENABLED_DEFAULT === "0" ||
      CONTEXT_COMPACTION_ENABLED_DEFAULT === "false" ||
      CONTEXT_COMPACTION_ENABLED_DEFAULT === "off" ||
      CONTEXT_COMPACTION_ENABLED_DEFAULT === "no");
  }

  getCompactionThreshold() {
    const configured = this.appSettings ? Number(this.appSettings.compactionThreshold) : NaN;
    if (Number.isFinite(configured)) return clampNumber(configured, 1024, 1_000_000, 160000);
    if (Number.isFinite(CONTEXT_COMPACTION_THRESHOLD_DEFAULT)) {
      return clampNumber(CONTEXT_COMPACTION_THRESHOLD_DEFAULT, 1024, 1_000_000, 160000);
    }
    return 160000;
  }

  getAdminSettings() {
    return {
      defaultModel: this.getDefaultModel(),
      defaultThreadPreamble: this.getDefaultThreadPreamble(),
      reasoningEffort: this.getReasoningEffort(),
      maxTurns: this.getMaxTurns(),
      compactionEnabled: this.getCompactionEnabled(),
      compactionThreshold: this.getCompactionThreshold(),
      ingredientsRoot: this.ingredientsRoot,
    };
  }

  setAdminSettings(next) {
    const current = this.getAdminSettings();
    const defaultModel = typeof next.defaultModel === "string" && next.defaultModel.trim()
      ? next.defaultModel.trim()
      : current.defaultModel;
    const defaultThreadPreamble = typeof next.defaultThreadPreamble === "string"
      ? next.defaultThreadPreamble.trim()
      : current.defaultThreadPreamble;
    const reasoningEffort = typeof next.reasoningEffort === "string" &&
      ALLOWED_REASONING_EFFORTS.includes(next.reasoningEffort.trim().toLowerCase())
      ? next.reasoningEffort.trim().toLowerCase()
      : current.reasoningEffort;
    const maxTurns = Number.isFinite(Number(next.maxTurns))
      ? clampNumber(Number(next.maxTurns), 1, 100, current.maxTurns)
      : current.maxTurns;
    const compactionEnabled = Object.prototype.hasOwnProperty.call(next, "compactionEnabled")
      ? Boolean(next.compactionEnabled)
      : current.compactionEnabled;
    const compactionThreshold = Number.isFinite(Number(next.compactionThreshold))
      ? clampNumber(Number(next.compactionThreshold), 1024, 1_000_000, current.compactionThreshold)
      : current.compactionThreshold;

    this.appSettings = {
      defaultModel,
      defaultThreadPreamble,
      reasoningEffort,
      maxTurns,
      compactionEnabled,
      compactionThreshold,
    };
    saveJson(APP_SETTINGS_PATH, this.appSettings);
    return this.getAdminSettings();
  }

  async listModels() {
    try {
      const listed = await this.openai.models.list();
      const data = Array.isArray(listed && listed.data) ? listed.data : [];
      const ids = data
        .map((m) => (m && typeof m.id === "string" ? m.id : ""))
        .filter(Boolean)
        .sort();
      if (!ids.length) return [{ id: this.getDefaultModel() }];
      return ids.map((id) => ({ id }));
    } catch {
      return [{ id: this.getDefaultModel() }];
    }
  }

  getThreadMeta(threadId) {
    return this.threadMeta[threadId] && typeof this.threadMeta[threadId] === "object"
      ? this.threadMeta[threadId]
      : {};
  }

  setThreadMeta(threadId, patch) {
    const current = this.getThreadMeta(threadId);
    this.threadMeta[threadId] = {
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    saveJson(THREAD_META_PATH, this.threadMeta);
  }

  listTrackedThreads() {
    const out = [];
    for (const [id, meta] of Object.entries(this.threadMeta)) {
      if (!id || !meta || typeof meta !== "object") continue;
      out.push({
        id,
        conversationDir: typeof meta.conversationDir === "string" ? meta.conversationDir : null,
        createdAt: typeof meta.createdAt === "string" ? Date.parse(meta.createdAt) : undefined,
        updatedAt: typeof meta.updatedAt === "string" ? Date.parse(meta.updatedAt) : undefined,
        preview: typeof meta.lastPreview === "string" ? meta.lastPreview : "",
      });
    }
    out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return out;
  }

  getThreadConversationDir(threadId) {
    const meta = this.getThreadMeta(threadId);
    return typeof meta.conversationDir === "string" ? meta.conversationDir : null;
  }

  createConversationDir(threadId) {
    const dirName = `${safeNowFolderName()}_${threadId}`;
    const fullPath = path.join(CONVERSATIONS_DIR, dirName);
    ensureDirSync(fullPath);
    return fullPath;
  }

  getThreadPreamble(threadId) {
    const meta = this.getThreadMeta(threadId);
    if (typeof meta.preamble === "string" && meta.preamble.trim()) return meta.preamble.trim();
    return this.getDefaultThreadPreamble();
  }

  getSession(threadId) {
    const cached = this.sessions.get(threadId);
    if (cached) return cached;
    const session = new OpenAIConversationsSession({
      conversationId: threadId,
      client: this.openai,
    });

    // Conversations API limits the number of items per create request (currently 20). The
    // upstream SDK's OpenAIConversationsSession.addItems() sends all items in one request, so
    // a tool-heavy turn can exceed the limit and fail. Chunk writes to keep the session stable.
    const origAddItems = typeof session.addItems === "function" ? session.addItems.bind(session) : null;
    if (origAddItems) {
      let pendingFollowerRequiredItem = null;
      session.addItems = async (items) => {
        let arr = Array.isArray(items) ? items.slice() : [];
        if (!arr.length) return;
        const MAX = 20;
        const requiresFollower = (it) => {
          if (!it || typeof it !== "object") return false;
          const t = typeof it.type === "string" ? it.type : "";
          // Conversations API requires `reasoning` to be sent together with its following `message`.
          return t === "reasoning";
        };

        // Persist only the minimal items needed for follow-up turns: messages + their associated reasoning.
        // Tool call traces can easily exceed per-request item limits and aren't required for UX.
        arr = arr.filter((it) => {
          if (!it || typeof it !== "object") return false;
          return it.type === "message" || it.type === "reasoning";
        });
        if (!arr.length) return;

        // The upstream SDK may emit items in multiple addItems() calls. Some item types (notably
        // reasoning) must be sent together with the immediately following item. Buffer a trailing
        // "requiresFollower" item and prepend it to the next addItems() call.
        if (pendingFollowerRequiredItem) {
          arr.unshift(pendingFollowerRequiredItem);
          pendingFollowerRequiredItem = null;
        }
        if (arr.length && requiresFollower(arr[arr.length - 1])) {
          pendingFollowerRequiredItem = arr.pop();
          if (!arr.length) return;
        }

        // Build chunks up to MAX items, but avoid splitting between a "requiresFollower" item and
        // its next item, otherwise the Conversations API can reject the request.
        const chunks = [];
        let i = 0;
        while (i < arr.length) {
          const chunk = [];
          while (i < arr.length && chunk.length < MAX) {
            chunk.push(arr[i]);
            i += 1;
          }

          // If the chunk is full and ends with an item that must be followed by the next item,
          // move it to the next chunk so it can be sent together with its follower.
          if (chunk.length === MAX && i < arr.length && requiresFollower(chunk[chunk.length - 1])) {
            i -= 1;
            chunk.pop();
          }

          // Safety: prevent infinite loops if something weird happens.
          if (!chunk.length) {
            chunk.push(arr[i]);
            i += 1;
          }

          chunks.push(chunk);
        }

        for (const chunk of chunks) {
          // Preserve item order across chunks.
          // eslint-disable-next-line no-await-in-loop
          await origAddItems(chunk);
        }
      };
    }

    this.sessions.set(threadId, session);
    return session;
  }

  async ensureThread({ model, threadId, preamble }) {
    if (threadId) {
      const existing = this.getThreadMeta(threadId);
      if (!existing || typeof existing !== "object" || !existing.createdAt) {
        this.setThreadMeta(threadId, {
          conversationDir: this.createConversationDir(threadId),
          createdAt: new Date().toISOString(),
          preamble: preamble || this.getDefaultThreadPreamble(),
        });
      }
      this.getSession(threadId);
      return {
        threadId,
        isNewThread: false,
        conversationDir: this.getThreadConversationDir(threadId),
      };
    }

    const newThreadId = await startOpenAIConversationsSession(this.openai);
    const conversationDir = this.createConversationDir(newThreadId);
    this.setThreadMeta(newThreadId, {
      conversationDir,
      createdAt: new Date().toISOString(),
      preamble: (typeof preamble === "string" && preamble.trim())
        ? preamble.trim()
        : this.getDefaultThreadPreamble(),
      lastPreview: "",
    });

    this.getSession(newThreadId);

    return {
      threadId: newThreadId,
      isNewThread: true,
      conversationDir,
    };
  }

  createResearchTools(turnLog) {
    const root = this.ingredientsRoot;

    // The Agents SDK defaults function tools to `strict: true`, which requires a
    // "strict JSON schema" that (among other constraints) doesn't play well with
    // optional Zod fields in some Zod v4 conversions. We instead:
    // - Provide explicit JSON Schemas for tool parameters
    // - Disable strict mode for these tools (`strict: false`)
    // - Keep runtime input validation via Zod inside each `execute()`
    const listFilesInput = z.object({
      contains: z.string().optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    });

    const searchInput = z.object({
      query: z.string().min(1),
      regex: z.boolean().optional(),
      caseSensitive: z.boolean().optional(),
      contextLines: z.number().int().min(0).max(4).optional(),
      maxMatches: z.number().int().min(1).max(300).optional(),
      glob: z.string().optional(),
    });

    const readFileInput = z.object({
      relativePath: z.string().min(1),
      startLine: z.number().int().min(1).optional(),
      maxLines: z.number().int().min(1).max(800).optional(),
    });

    const listFilesTool = tool({
      name: "list_ingredient_files",
      description: "List TXT files under the ingredient corpus. Use this to discover available documents.",
      strict: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          contains: { type: "string", description: "Optional substring filter for relative file paths." },
          limit: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum files to return." },
        },
      },
      execute: async (input) => {
        if (turnLog) turnLog.recordToolCall();
        const parsed = listFilesInput.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: "Invalid input. Expected { contains?: string, limit?: number }" };
        }
        if (!fs.existsSync(root)) {
          return {
            ok: false,
            error: `Ingredient directory not found: ${root}`,
          };
        }

        const contains = typeof parsed.data.contains === "string" ? parsed.data.contains.trim().toLowerCase() : "";
        const limit = clampNumber(parsed.data.limit, 1, 2000, 400);
        const files = listTextFiles(root, 20000)
          .map((full) => path.relative(root, full).replace(/\\/g, "/"))
          .filter((rel) => (!contains || rel.toLowerCase().includes(contains)))
          .slice(0, limit);

        return {
          ok: true,
          root,
          count: files.length,
          files,
        };
      },
    });

    const searchTool = tool({
      name: "search_ingredient_text",
      description: "Search the ingredient TXT corpus by keyword or regex. Use repeatedly with alternate Korean/English terms and variants.",
      strict: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, description: "Keyword or regex pattern to search for." },
          regex: { type: "boolean", description: "If true, treat query as regex. Default false." },
          caseSensitive: { type: "boolean", description: "If true, do case-sensitive search. Default false." },
          contextLines: { type: "integer", minimum: 0, maximum: 4, description: "Context lines around matches (0-4)." },
          maxMatches: { type: "integer", minimum: 1, maximum: 300, description: "Max matches to return (1-300)." },
          glob: { type: "string", description: "Optional file glob filter (ripgrep -g)." },
        },
      },
      execute: async (input) => {
        const parsed = searchInput.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: "Invalid input. Expected { query: string, ... }" };
        }
        if (!fs.existsSync(root)) {
          return {
            ok: false,
            error: `Ingredient directory not found: ${root}`,
          };
        }

        const query = String(parsed.data.query || "").trim();
        if (!query) return { ok: false, error: "query is required" };

        const regex = Boolean(parsed.data.regex);
        const caseSensitive = Boolean(parsed.data.caseSensitive);
        const contextLines = clampNumber(parsed.data.contextLines, 0, 4, 0);
        const maxMatches = clampNumber(parsed.data.maxMatches, 1, 300, 80);
        const glob = typeof parsed.data.glob === "string" ? parsed.data.glob.trim() : "";

        const args = ["-n", "--no-heading", "--color", "never", "--max-count", String(maxMatches)];
        if (!caseSensitive) args.push("-i");
        if (!regex) args.push("-F");
        if (contextLines > 0) args.push("-C", String(contextLines));
        if (glob) args.push("-g", glob);
        args.push(query, ".");

        let hits = [];
        let mode = "rg";

        const rg = spawnSync("rg", args, {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });

        if (turnLog) {
          turnLog.recordCliCommand({
            command: "rg",
            args,
            cwd: root,
            exitCode: Number.isFinite(rg.status) ? rg.status : -1,
            error: rg.error ? (rg.error.message || String(rg.error)) : "",
            stderr: String(rg.stderr || "").trim().slice(0, 1000),
          });
        }

        if (!rg.error) {
          hits = parseRgMatches(rg.stdout, maxMatches).map((h) => ({
            file: h.file.replace(/\\/g, "/"),
            line: h.line,
            text: h.text,
          }));
        } else {
          mode = "fallback_scan";
        }

        if (!hits.length) {
          const normalizedQuery = query.toLowerCase().replace(/\s+/g, "");
          if (normalizedQuery) {
            const files = listTextFiles(root, 12000);
            const results = [];
            for (const file of files) {
              if (results.length >= maxMatches) break;
              let raw;
              try {
                raw = fs.readFileSync(file, "utf8");
              } catch {
                continue;
              }
              const lines = raw.split(/\r?\n/);
              for (let i = 0; i < lines.length; i += 1) {
                if (results.length >= maxMatches) break;
                const normalizedLine = lines[i].toLowerCase().replace(/\s+/g, "");
                if (!normalizedLine.includes(normalizedQuery)) continue;
                results.push({
                  file: path.relative(root, file).replace(/\\/g, "/"),
                  line: i + 1,
                  text: lines[i],
                });
              }
            }
            if (results.length) {
              hits = results;
              mode = "normalized_scan";
            }
          }
        }

        const grepHitsInjected = hits.length;
        const grepCharsInjected = hits.reduce((sum, h) => sum + String(h && h.text ? h.text : "").length, 0);
        if (turnLog) {
          turnLog.recordToolCall({
            grepHitsInjected,
            grepCharsInjected,
          });
        }

        return {
          ok: true,
          root,
          mode,
          query,
          regex,
          caseSensitive,
          count: hits.length,
          hits,
        };
      },
    });

    const readFileTool = tool({
      name: "read_ingredient_file",
      description: "Read a specific TXT file from the ingredient corpus for detailed analysis.",
      strict: false,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["relativePath"],
        properties: {
          relativePath: { type: "string", minLength: 1, description: "Relative path to a .txt file under the corpus root." },
          startLine: { type: "integer", minimum: 1, description: "1-based start line. Default 1." },
          maxLines: { type: "integer", minimum: 1, maximum: 800, description: "Max lines to return (1-800)." },
        },
      },
      execute: async (input) => {
        if (turnLog) turnLog.recordToolCall();
        const parsed = readFileInput.safeParse(input);
        if (!parsed.success) {
          return { ok: false, error: "Invalid input. Expected { relativePath: string, ... }" };
        }
        if (!fs.existsSync(root)) {
          return {
            ok: false,
            error: `Ingredient directory not found: ${root}`,
          };
        }

        let full;
        try {
          full = toSafeRelPath(root, parsed.data.relativePath);
        } catch (err) {
          return { ok: false, error: err.message || String(err) };
        }

        let raw;
        try {
          raw = fs.readFileSync(full, "utf8");
        } catch (err) {
          return { ok: false, error: err.message || String(err) };
        }

        const lines = raw.split(/\r?\n/);
        const startLine = clampNumber(parsed.data.startLine, 1, Math.max(lines.length, 1), 1);
        const maxLines = clampNumber(parsed.data.maxLines, 1, 800, 260);
        const startIndex = startLine - 1;
        const endIndex = Math.min(lines.length, startIndex + maxLines);

        return {
          ok: true,
          relativePath: path.relative(root, full).replace(/\\/g, "/"),
          startLine,
          endLine: endIndex,
          totalLines: lines.length,
          text: lines.slice(startIndex, endIndex).join("\n"),
        };
      },
    });

    return [listFilesTool, searchTool, readFileTool];
  }

  buildAgent({ model, threadId, turnLog }) {
    const reasoningEffort = this.getReasoningEffort();
    const compactionEnabled = this.getCompactionEnabled();
    const compactionThreshold = this.getCompactionThreshold();
    const instructions = this.buildAgentInstructions(threadId);

    const modelSettings = {};
    if (!(REASONING_SUMMARY === "off" || REASONING_SUMMARY === "false" || REASONING_SUMMARY === "0")) {
      modelSettings.reasoning = {
        effort: reasoningEffort,
        summary: (["auto", "concise", "detailed"].includes(REASONING_SUMMARY) ? REASONING_SUMMARY : "auto"),
      };
    }
    if (compactionEnabled) {
      modelSettings.providerData = {
        context_management: [
          { type: "compaction", compact_threshold: compactionThreshold },
        ],
      };
    }

    return new Agent({
      name: "IngredientDeepResearchAgent",
      model: model || this.getDefaultModel(),
      instructions,
      modelSettings,
      tools: this.createResearchTools(turnLog),
    });
  }

  buildAgentInstructions(threadId) {
    const preamble = this.getThreadPreamble(threadId);
    return [
      preamble,
      "",
      "Operational requirements:",
      "- You are performing deep research over the provided TXT corpus.",
      "- Always use the search/read tools to gather evidence before answering.",
      "- Try multiple query variants (synonyms, Korean/English forms, spacing/hyphen variants).",
      "- For OCR/PDF artifacts, test fragmented terms and normalized forms.",
      "- Keep searching iteratively until you are satisfied that recall is strong.",
      "- In the final answer, list matched materials with short evidence and file references.",
      "- If evidence is weak, explicitly say what is missing and what additional searches were attempted.",
      "- Do not invent citations.",
    ].join("\n");
  }

  async readThreadMessages(threadId) {
    const session = this.getSession(threadId);
    const items = await session.getItems();
    const messages = [];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.type !== "message") continue;
      if (item.role !== "user" && item.role !== "assistant") continue;

      const text = extractTextFromMessageContent(item.content);
      if (!text) continue;
      messages.push({ role: item.role, text });
    }

    return { messages };
  }

  async interruptTurn({ turnId }) {
    if (!turnId) throw new Error("turnId is required");
    const active = this.activeTurns.get(turnId);
    if (!active) return;
    active.abortController.abort();
  }

  async runTurn({ threadId, model, text, stream = false, conversationDir = "", onMeta, onDelta, onEvent }) {
    const session = this.getSession(threadId);
    const turnId = `turn_${Date.now()}_${crypto.randomBytes(5).toString("hex")}`;
    const maxTurns = this.getMaxTurns();
    const compactionEnabled = this.getCompactionEnabled();
    const compactionThreshold = this.getCompactionThreshold();
    const turnLog = createTurnLogFiles({
      turnId,
      threadId,
      conversationDir,
      model: model || this.getDefaultModel(),
      maxTurns,
      userQuery: text,
      compactionEnabled,
      compactionThreshold,
    });
    const systemPrompt = this.buildAgentInstructions(threadId);
    turnLog.setRunInfo({
      reasoningEffort: this.getReasoningEffort(),
      maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 0),
      systemPrompt,
    });
    const agent = this.buildAgent({ model, threadId, turnLog });

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), TURN_TIMEOUT_MS);
    this.activeTurns.set(turnId, { abortController, createdAt: Date.now(), threadId });

    let accumulated = "";
    let reasoningLog = null;

    const openReasoningLog = () => {
      if (!conversationDir || typeof conversationDir !== "string") return null;
      try {
        fs.mkdirSync(conversationDir, { recursive: true });
        const logPath = path.join(conversationDir, `reasoning_summary_${turnId}.jsonl`);
        const stream = fs.createWriteStream(logPath, { flags: "a" });
        return {
          logPath,
          stream,
          write(obj) {
            try {
              stream.write(`${JSON.stringify({ ts: new Date().toISOString(), ...obj })}\n`);
            } catch {
              // Best-effort logging only.
            }
          },
          close() {
            try {
              stream.end();
            } catch {
              // ignore
            }
          },
        };
      } catch {
        return null;
      }
    };

    try {
      if (onMeta) onMeta({ threadId, turnId });

      if (!stream) {
        const result = await run(agent, text, {
          session,
          maxTurns,
          signal: abortController.signal,
        });

        const finalText = formatFinalOutput(result.finalOutput);
        if (finalText) {
          accumulated = finalText;
          this.setThreadMeta(threadId, { lastPreview: finalText.slice(0, 220) });
        }
        turnLog.finalize({
          status: abortController.signal.aborted ? "interrupted" : "completed",
          turnsUsed: 1,
          finalAnswer: finalText,
        });

        return {
          threadId,
          turnId,
          status: abortController.signal.aborted ? "interrupted" : "completed",
          text: finalText,
          turnsUsed: 1,
          maxTurns,
          turnLogMdPath: path.relative(__dirname, turnLog.mdPath).replace(/\\/g, "/"),
          turnLogJsonPath: path.relative(__dirname, turnLog.jsonPath).replace(/\\/g, "/"),
          chatLogMdPath: path.relative(__dirname, turnLog.chatMdPath).replace(/\\/g, "/"),
          chatLogJsonPath: path.relative(__dirname, turnLog.chatJsonPath).replace(/\\/g, "/"),
        };
      }

      reasoningLog = openReasoningLog();
      if (reasoningLog) reasoningLog.write({ event: "turn_start", threadId, turnId, model });

      const responseIds = new Set();
      const streamResult = await run(agent, text, {
        session,
        stream: true,
        maxTurns,
        signal: abortController.signal,
      });

      for await (const evt of streamResult) {
        if (evt && evt.type === "raw_model_stream_event") {
          const raw = evt.data || {};
          const rawType = typeof raw.type === "string" ? raw.type : "raw_event";
          // OpenAIResponsesModel emits wrapper events like {type:"model", event:{type:"response.*"}}
          // alongside simplified events like {type:"output_text_delta", ...}.
          const underlyingType = raw && typeof raw === "object" && raw.event && typeof raw.event.type === "string"
            ? raw.event.type
            : "";
          const responseId = extractResponseIdFromRawEvent(underlyingType ? raw.event : raw);
          if (responseId) responseIds.add(responseId);
          if (responseId) turnLog.setRunInfo({ runId: responseId });

          // Map Responses streaming "reasoning summary" events onto the Codex App Server-style
          // event names that `public/index.html` already renders as a temporary assistant message.
          // We intentionally do NOT emit raw chain-of-thought.
          const eventType = underlyingType || rawType;
          let mappedMethod = rawType;
          let mappedParams = raw;

          if (eventType === "response.compaction.done" || eventType === "response.compaction.created") {
            turnLog.markCompactionTriggered();
          }

          if (eventType === "response.completed") {
            const src = underlyingType ? raw.event : raw;
            const usage = src && src.response && src.response.usage ? src.response.usage
              : (src && src.usage ? src.usage : null);
            if (usage && typeof usage === "object") {
              const inputTokens = Number(usage.input_tokens || usage.inputTokens || 0);
              const outputTokens = Number(usage.output_tokens || usage.outputTokens || 0);
              const totalTokens = Number(usage.total_tokens || usage.totalTokens || (inputTokens + outputTokens));
              const outputDetails = usage.output_tokens_details || usage.outputTokensDetails || {};
              const reasoningTokens = Number(
                outputDetails.reasoning_tokens ||
                outputDetails.reasoningTokens ||
                usage.reasoning_tokens ||
                usage.reasoningTokens ||
                0
              );
              const inputDetails = usage.input_tokens_details || usage.inputTokensDetails || {};
              const cachedTokens = Number(
                inputDetails.cached_tokens ||
                inputDetails.cachedTokens ||
                usage.cached_tokens ||
                usage.cachedTokens ||
                0
              );
              turnLog.recordUsage({
                inputTokens,
                cachedTokens,
                outputTokens,
                reasoningTokens,
                totalTokens,
              });
            }
          }

          if (eventType === "response.reasoning_summary_part.added" || eventType === "response.reasoning_summary_part.done") {
            // Prefer part boundaries over per-token deltas for UI updates.
            // The part events can include a full `text` chunk that we can render at once.
            const src = underlyingType ? raw.event : raw;
            const phase = eventType.endsWith(".done") ? "done" : "added";
            const partText = typeof src.text === "string"
              ? src.text
              : (src.part && typeof src.part.text === "string" ? src.part.text : "");
            const summaryIndex = typeof src.summary_index === "number"
              ? src.summary_index
              : (typeof src.summaryIndex === "number" ? src.summaryIndex : null);

            mappedMethod = "item/reasoning/summaryPartAdded";
            mappedParams = { phase, text: partText, summaryIndex, raw };
            if (turnLog) {
              turnLog.recordReasoning({
                kind: "summary_part",
                phase,
                summaryIndex,
                text: partText,
              });
            }
            if (reasoningLog) reasoningLog.write({
              event: "summary_part",
              rawType: eventType,
              mappedMethod,
              phase,
              summaryIndex,
              text: partText,
            });
          } else if (eventType === "response.reasoning_summary_text.delta") {
            const src = underlyingType ? raw.event : raw;
            const d = typeof src.delta === "string"
              ? src.delta
              : (typeof src.textDelta === "string" ? src.textDelta : "");
            mappedMethod = "item/reasoning/summaryTextDelta";
            const summaryIndex = typeof src.summary_index === "number"
              ? src.summary_index
              : (typeof src.summaryIndex === "number" ? src.summaryIndex : null);
            mappedParams = { delta: d, summaryIndex, raw };
            if (turnLog && d) {
              turnLog.recordReasoning({
                kind: "summary_delta",
                summaryIndex,
                delta: d,
              });
            }
            if (reasoningLog) reasoningLog.write({ event: "summary_text_delta", rawType: eventType, mappedMethod, delta: d });
          }

          if (onEvent) onEvent({ method: mappedMethod, params: mappedParams });

          // Text output deltas can arrive either as:
          // - the raw Responses streaming event: response.output_text.delta (nested under raw.event)
          // - the Agents SDK normalized wrapper: output_text_delta (top-level raw.delta)
          const isTextDelta = rawType === "output_text_delta" || eventType === "response.output_text.delta" ||
            (rawType.includes("output_text") && rawType.endsWith(".delta"));
          const deltaSource = eventType === "response.output_text.delta" && raw && raw.event ? raw.event : raw;
          const delta = typeof deltaSource.delta === "string"
            ? deltaSource.delta
            : (typeof deltaSource.textDelta === "string" ? deltaSource.textDelta : "");

          if (isTextDelta && delta) {
            accumulated += delta;
            if (onDelta) onDelta(delta);
          }
          continue;
        }

        if (evt && evt.type === "run_item_stream_event") {
          if (onEvent) {
            const item = evt.item && typeof evt.item.toJSON === "function"
              ? evt.item.toJSON()
              : { type: evt.item && evt.item.type ? evt.item.type : "unknown" };
            onEvent({ method: `run_item/${evt.name}`, params: item });
          }

          if (evt.name === "message_output_created") {
            const rawItem = evt.item && evt.item.rawItem ? evt.item.rawItem : null;
            const completedText = parseAssistantTextFromRawItem(rawItem);
            if (completedText && completedText.length > accumulated.length) {
              accumulated = completedText;
            }
          }
          continue;
        }

        if (evt && evt.type === "agent_updated_stream_event") {
          if (onEvent) onEvent({ method: "agent_updated", params: { name: evt.agent && evt.agent.name } });
        }
      }

      await streamResult.completed;

      const finalText = formatFinalOutput(streamResult.finalOutput) || accumulated;
      if (finalText) this.setThreadMeta(threadId, { lastPreview: finalText.slice(0, 220) });

      if (reasoningLog) {
        reasoningLog.write({ event: "turn_end", status: abortController.signal.aborted ? "interrupted" : "completed" });
      }
      turnLog.finalize({
        status: abortController.signal.aborted ? "interrupted" : "completed",
        turnsUsed: responseIds.size || 1,
        finalAnswer: finalText,
      });

      return {
        threadId,
        turnId,
        status: abortController.signal.aborted ? "interrupted" : "completed",
        text: finalText,
        turnsUsed: responseIds.size || 1,
        maxTurns,
        turnLogMdPath: path.relative(__dirname, turnLog.mdPath).replace(/\\/g, "/"),
        turnLogJsonPath: path.relative(__dirname, turnLog.jsonPath).replace(/\\/g, "/"),
        chatLogMdPath: path.relative(__dirname, turnLog.chatMdPath).replace(/\\/g, "/"),
        chatLogJsonPath: path.relative(__dirname, turnLog.chatJsonPath).replace(/\\/g, "/"),
      };
    } catch (err) {
      const message = err && err.message ? String(err.message) : String(err);
      const isAbort = abortController.signal.aborted || /abort|cancel/i.test(message);
      if (isAbort) {
        if (reasoningLog) reasoningLog.write({ event: "turn_end", status: "interrupted" });
        turnLog.finalize({
          status: "interrupted",
          turnsUsed: 1,
          finalAnswer: accumulated,
          error: message,
        });
        return {
          threadId,
          turnId,
          status: "interrupted",
          text: accumulated,
          turnsUsed: 1,
          maxTurns,
          turnLogMdPath: path.relative(__dirname, turnLog.mdPath).replace(/\\/g, "/"),
          turnLogJsonPath: path.relative(__dirname, turnLog.jsonPath).replace(/\\/g, "/"),
          chatLogMdPath: path.relative(__dirname, turnLog.chatMdPath).replace(/\\/g, "/"),
          chatLogJsonPath: path.relative(__dirname, turnLog.chatJsonPath).replace(/\\/g, "/"),
        };
      }
      if (reasoningLog) reasoningLog.write({ event: "turn_error", message });
      turnLog.finalize({
        status: "error",
        finalAnswer: accumulated,
        error: message,
      });
      throw err;
    } finally {
      clearTimeout(timeout);
      this.activeTurns.delete(turnId);
      if (reasoningLog) {
        reasoningLog.write({ event: "turn_cleanup" });
        reasoningLog.close();
      }
    }
  }
}

const agentsClient = new AgentsClient();

function serveStatic(req, res, session) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const reqUrl = req.url || "/";
  let fileName = "";

  if (reqUrl === "/" || reqUrl === "/index.html") {
    if (!session) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return true;
    }
    fileName = "index.html";
  } else if (reqUrl === "/admin" || reqUrl === "/admin.html") {
    if (!session) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return true;
    }
    if (!session.user || session.user.role !== "admin") {
      res.writeHead(302, { Location: "/" });
      res.end();
      return true;
    }
    fileName = "admin.html";
  } else if (reqUrl === "/test" || reqUrl === "/test.html") {
    if (!session) {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return true;
    }
    fileName = "test.html";
  } else if (reqUrl === "/login" || reqUrl === "/login.html") {
    if (session) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return true;
    }
    fileName = "login.html";
  } else {
    return false;
  }

  try {
    const filePath = path.join(PUBLIC_DIR, fileName);
    const body = fs.readFileSync(filePath);
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": body.length,
      // Avoid UI papercuts while iterating quickly: refresh should always pick up latest HTML.
      "Cache-Control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  } catch {
    toJson(res, 500, { error: "Failed to load UI" });
    return true;
  }
}

const server = http.createServer(async (req, res) => {
  const session = getSessionFromReq(req);
  if (serveStatic(req, res, session)) return;

  const reqUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = reqUrl.pathname;

  try {
    // Browsers request this automatically; keep it unauthenticated and quiet.
    if (req.method === "GET" && pathname === "/favicon.ico") {
      res.writeHead(204, { "Cache-Control": "public, max-age=86400" });
      res.end();
      return;
    }

    if (req.method === "GET" && pathname === "/health") {
      return toJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/version") {
      const build = getBuildInfo();
      return toJson(res, 200, {
        name: "MaterialSearch",
        version: PACKAGE_VERSION,
        git: getGitInfo(),
        build,
        startedAt: SERVER_STARTED_AT,
        pid: process.pid,
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/login") {
      const body = await parseJsonBody(req);
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      const user = authStore.authenticate(username, password);
      if (!user) return toJson(res, 401, { error: "Invalid credentials" });
      const created = authStore.createSession(user.id);
      setSessionCookie(res, created.token);
      return toJson(res, 200, {
        ok: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
        },
      });
    }

    if (req.method === "POST" && pathname === "/api/auth/logout") {
      const current = session;
      if (current && current.token) authStore.deleteSession(current.token);
      clearSessionCookie(res);
      return toJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && pathname === "/api/auth/me") {
      if (!session) return toJson(res, 401, { error: "Unauthorized" });
      return toJson(res, 200, {
        user: {
          id: session.user.id,
          username: session.user.username,
          role: session.user.role,
        },
      });
    }

    if (!session) return toJson(res, 401, { error: "Unauthorized" });

    if (req.method === "GET" && pathname === "/api/models") {
      const data = await agentsClient.listModels();
      return toJson(res, 200, { data });
    }

    if (req.method === "GET" && pathname === "/api/account") {
      return toJson(res, 200, {
        provider: "openai-agents-sdk",
        modelDefault: agentsClient.getDefaultModel(),
      });
    }

    if (req.method === "GET" && req.url === "/api/admin/settings") {
      if (session.user.role !== "admin") return toJson(res, 403, { error: "Forbidden" });
      return toJson(res, 200, agentsClient.getAdminSettings());
    }

    if (req.method === "POST" && req.url === "/api/admin/settings") {
      if (session.user.role !== "admin") return toJson(res, 403, { error: "Forbidden" });
      const body = await parseJsonBody(req);
      const settings = agentsClient.setAdminSettings({
        defaultModel: typeof body.defaultModel === "string" ? body.defaultModel : undefined,
        defaultThreadPreamble: typeof body.defaultThreadPreamble === "string" ? body.defaultThreadPreamble : undefined,
        reasoningEffort: typeof body.reasoningEffort === "string" ? body.reasoningEffort : undefined,
        maxTurns: Number.isFinite(Number(body.maxTurns)) ? Number(body.maxTurns) : undefined,
        compactionEnabled: Object.prototype.hasOwnProperty.call(body, "compactionEnabled")
          ? Boolean(body.compactionEnabled)
          : undefined,
        compactionThreshold: Number.isFinite(Number(body.compactionThreshold))
          ? Number(body.compactionThreshold)
          : undefined,
      });
      return toJson(res, 200, settings);
    }

    if (req.method === "GET" && req.url === "/api/admin/users") {
      if (session.user.role !== "admin") return toJson(res, 403, { error: "Forbidden" });
      return toJson(res, 200, { data: authStore.listUsers() });
    }

    if (req.method === "POST" && req.url === "/api/admin/users") {
      if (session.user.role !== "admin") return toJson(res, 403, { error: "Forbidden" });
      const body = await parseJsonBody(req);
      const user = authStore.createUser({
        username: typeof body.username === "string" ? body.username : "",
        password: typeof body.password === "string" ? body.password : "",
        role: body.role === "admin" ? "admin" : "user",
      });
      return toJson(res, 200, { user });
    }

    if (req.method === "POST" && req.url === "/api/admin/users/password") {
      if (session.user.role !== "admin") return toJson(res, 403, { error: "Forbidden" });
      const body = await parseJsonBody(req);
      const userId = Number(body.userId);
      const password = typeof body.password === "string" ? body.password : "";
      const user = authStore.setUserPassword(userId, password);
      return toJson(res, 200, { user });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/threads") {
      if (session.user.role === "admin") {
        const data = agentsClient.listTrackedThreads();
        return toJson(res, 200, { data, nextCursor: null });
      }

      const rows = authStore.listUserThreads(session.user.id);
      const metaById = new Map(agentsClient.listTrackedThreads().map((t) => [t.id, t]));
      const data = rows.map((r) => {
        const m = metaById.get(r.thread_id) || {};
        return {
          id: r.thread_id,
          createdAt: m.createdAt || Date.parse(r.created_at),
          updatedAt: m.updatedAt || Date.parse(r.last_used_at),
          preview: typeof m.preview === "string" ? m.preview : "",
        };
      });
      return toJson(res, 200, { data, nextCursor: null });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/conversations") {
      const rows = authStore.listUserThreads(session.user.id);
      const metaById = new Map(agentsClient.listTrackedThreads().map((t) => [t.id, t]));
      const data = rows.map((r) => {
        const m = metaById.get(r.thread_id) || {};
        return {
          id: r.thread_id,
          conversationDir: typeof m.conversationDir === "string" ? m.conversationDir : null,
          createdAt: m.createdAt || Date.parse(r.created_at),
          updatedAt: m.updatedAt || Date.parse(r.last_used_at),
          preview: typeof m.preview === "string" ? m.preview : "",
        };
      });
      return toJson(res, 200, { data });
    }

    if (req.method === "GET" && reqUrl.pathname === "/api/thread/messages") {
      const threadId = reqUrl.searchParams.get("threadId") || "";
      if (!threadId) return toJson(res, 400, { error: "threadId is required" });
      if (!authStore.userOwnsThread(session.user.id, threadId)) {
        return toJson(res, 403, { error: "Thread does not belong to current user" });
      }

      const data = await agentsClient.readThreadMessages(threadId);
      const conversationDir = agentsClient.getThreadConversationDir(threadId);
      authStore.touchUserThread(session.user.id, threadId);
      return toJson(res, 200, {
        threadId,
        conversationDir: conversationDir || null,
        messages: data.messages,
      });
    }

    if (req.method === "POST" && req.url === "/api/thread/ensure") {
      const body = await parseJsonBody(req);
      const incomingThreadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      if (incomingThreadId && !authStore.userOwnsThread(session.user.id, incomingThreadId)) {
        return toJson(res, 403, { error: "Thread does not belong to current user" });
      }

      const requestedPreamble = typeof body.preamble === "string" && body.preamble.trim()
        ? body.preamble.trim()
        : "";

      const ensured = await agentsClient.ensureThread({
        model: typeof body.model === "string" && body.model.trim()
          ? body.model.trim()
          : agentsClient.getDefaultModel(),
        threadId: incomingThreadId,
        preamble: requestedPreamble || (!incomingThreadId ? agentsClient.getDefaultThreadPreamble() : ""),
      });

      authStore.touchUserThread(session.user.id, ensured.threadId);

      return toJson(res, 200, {
        threadId: ensured.threadId,
        isNewThread: ensured.isNewThread,
        conversationDir: ensured.conversationDir,
        preambleApplied: Boolean(requestedPreamble || (!incomingThreadId && agentsClient.getDefaultThreadPreamble())),
      });
    }

    if (req.method === "POST" && req.url === "/api/turn/interrupt") {
      const body = await parseJsonBody(req);
      const incomingThreadId = typeof body.threadId === "string" ? body.threadId.trim() : "";
      if (!incomingThreadId || !authStore.userOwnsThread(session.user.id, incomingThreadId)) {
        return toJson(res, 403, { error: "Thread does not belong to current user" });
      }

      await agentsClient.interruptTurn({ turnId: body.turnId });
      return toJson(res, 200, { ok: true });
    }

    if (req.method === "POST" && req.url === "/api/turn") {
      const body = await parseJsonBody(req);
      const model = typeof body.model === "string" && body.model.trim()
        ? body.model.trim()
        : agentsClient.getDefaultModel();
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return toJson(res, 400, { error: "text is required" });

      const requestedPreamble = typeof body.preamble === "string" && body.preamble.trim()
        ? body.preamble.trim()
        : "";
      const incomingThreadId = typeof body.threadId === "string" ? body.threadId.trim() : "";

      if (incomingThreadId && !authStore.userOwnsThread(session.user.id, incomingThreadId)) {
        return toJson(res, 403, { error: "Thread does not belong to current user" });
      }

      const ensured = await agentsClient.ensureThread({
        model,
        threadId: incomingThreadId,
        preamble: requestedPreamble || (!incomingThreadId ? agentsClient.getDefaultThreadPreamble() : ""),
      });

      authStore.touchUserThread(session.user.id, ensured.threadId);

      const result = await agentsClient.runTurn({
        threadId: ensured.threadId,
        model,
        text,
        stream: false,
      });

      return toJson(res, 200, {
        ...result,
        conversationDir: ensured.conversationDir,
      });
    }

	    if (req.method === "POST" && req.url === "/api/turn/stream") {
	      const body = await parseJsonBody(req);
	      const model = typeof body.model === "string" && body.model.trim()
	        ? body.model.trim()
	        : agentsClient.getDefaultModel();
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return toJson(res, 400, { error: "text is required" });

      const requestedPreamble = typeof body.preamble === "string" && body.preamble.trim()
        ? body.preamble.trim()
        : "";
      const incomingThreadId = typeof body.threadId === "string" ? body.threadId.trim() : "";

      if (incomingThreadId && !authStore.userOwnsThread(session.user.id, incomingThreadId)) {
        return toJson(res, 403, { error: "Thread does not belong to current user" });
      }

      const ensured = await agentsClient.ensureThread({
        model,
        threadId: incomingThreadId,
        preamble: requestedPreamble || (!incomingThreadId ? agentsClient.getDefaultThreadPreamble() : ""),
      });

      authStore.touchUserThread(session.user.id, ensured.threadId);

      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      sendSse(res, { type: "status", message: "running" });

	      try {
	        const result = await agentsClient.runTurn({
	          threadId: ensured.threadId,
	          model,
	          text,
	          stream: true,
	          conversationDir: ensured.conversationDir,
	          onMeta: ({ threadId, turnId }) => {
	            sendSse(res, {
	              type: "meta",
	              threadId,
	              turnId,
	              conversationDir: ensured.conversationDir,
	            });
	          },
	          // Intentionally do NOT stream the final assistant answer token-by-token.
	          // We still stream intermediate agent events (reasoning summary boundaries, tool progress, etc.)
	          // and then send the final answer once as `type: "done"`.
	          onEvent: (evt) => {
	            sendSse(res, { type: "event", method: evt.method, params: evt.params || {} });
	          },
	        });

        sendSse(res, { type: "done", ...result });
        res.write("data: [DONE]\n\n");
        res.end();
      } catch (err) {
        sendSse(res, { type: "error", message: err.message || String(err) });
        res.write("data: [DONE]\n\n");
        res.end();
      }
      return;
    }

    toJson(res, 404, { error: "Not found" });
  } catch (err) {
    toJson(res, 500, { error: err.message || "Internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`MaterialSearch (Agents SDK) listening on http://127.0.0.1:${PORT}`);
  console.log(`Ingredient corpus root: ${agentsClient.ingredientsRoot}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
