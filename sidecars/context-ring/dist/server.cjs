"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { URL } = require("node:url");
const { execFile } = require("node:child_process");

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || "8000", 10) || 8000;
const TOKEN =
  process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_AUTH_TOKEN ||
  process.env.ANTIGRAVITY_SIDECAR_WEB_TOKEN ||
  "";

const UI_HTML_PATH = path.resolve(__dirname, "..", "ui.html");
const DATA_DIR = path.join(getAppDataDir(), "sidecar_data", "claude-context-ring");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const COMPACT_STATE_PATH = path.join(DATA_DIR, "compact-state.json");

const MAX_MANAGED_SESSIONS = 10;

const DEFAULT_SETTINGS = {
  windowSize: 0, // Always 0 = Auto (follows real AGY model max_token_limit)
  autoCompactEnabled: false,
  autoCompactThresholdPct: 60,
};

function getRealModelWindow(modelName) {
  const m = String(modelName || "").toLowerCase();
  if (m.includes("claude-opus-5-5") || m.includes("claude-sonnet-5-5")) return 840000;
  if (m.includes("gemini-4") || m.includes("orchestrator") || m.includes("worker-agy")) return 512000;
  if (m.includes("gemini-3.8") || m.includes("gemini-3.5")) return 256000;
  if (m.includes("gemini-2.5")) return 128000;
  if (m.includes("gpt-oss")) return 80000;
  return 512000; // default for current AGY Gemini 4 models
}

function getAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), ".gemini", "antigravity");
}

function getConfigDir() {
  return path.join(os.homedir(), ".gemini", "config");
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      return {
        windowSize: 0,
        autoCompactEnabled: Boolean(parsed.autoCompactEnabled),
        autoCompactThresholdPct:
          Number.isFinite(Number(parsed.autoCompactThresholdPct)) &&
          Number(parsed.autoCompactThresholdPct) >= 10 &&
          Number(parsed.autoCompactThresholdPct) <= 99
            ? Math.round(Number(parsed.autoCompactThresholdPct))
            : DEFAULT_SETTINGS.autoCompactThresholdPct,
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

function saveSettings(next) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf-8");
}

let settings = loadSettings();

function isValidId(id) {
  return (
    typeof id === "string" &&
    id.length > 0 &&
    id.length <= 128 &&
    /^[a-zA-Z0-9_-]+$/.test(id)
  );
}

function getAgentApiExe() {
  const envExe = process.env.ANTIGRAVITY_AGENTAPI_EXE?.trim();
  if (envExe) {
    return {
      file: envExe,
      prefix: path.basename(envExe).toLowerCase().startsWith("agentapi") ? [] : ["agentapi"],
    };
  }
  return { file: "agentapi", prefix: [] };
}

function runAgentApi(args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const { file, prefix } = getAgentApiExe();
    execFile(file, [...prefix, ...args], { encoding: "utf-8", timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, error: err.message, stderr: stderr ? String(stderr).trim() : "" });
        return;
      }
      const out = stdout ? String(stdout).trim() : "";
      try {
        resolve({ ok: true, data: out ? JSON.parse(out) : {} });
      } catch {
        resolve({ ok: true, raw: out });
      }
    });
  });
}

// Measure real AGY overhead (Skills, Memory/Rules, MCP deferred) cached for 30s
let envCache = { ts: 0, data: null };
function getEnvOverhead() {
  if (envCache.data && Date.now() - envCache.ts < 30000) return envCache.data;

  const appDir = getAppDataDir();
  const cfgDir = getConfigDir();

  // 1. Skills (only name + description are injected via progressive disclosure)
  let skillsChars = 0;
  let skillsCount = 0;
  const skillRoots = [path.join(appDir, "builtin", "skills")];
  const pluginsDir = path.join(cfgDir, "plugins");
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const p of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (p.isDirectory()) skillRoots.push(path.join(pluginsDir, p.name, "skills"));
      }
    } catch {}
  }
  const customSkillsDir = path.join(cfgDir, "skills");
  if (fs.existsSync(customSkillsDir)) skillRoots.push(customSkillsDir);

  for (const root of skillRoots) {
    if (!fs.existsSync(root)) continue;
    try {
      for (const s of fs.readdirSync(root, { withFileTypes: true })) {
        if (!s.isDirectory()) continue;
        const mdPath = path.join(root, s.name, "SKILL.md");
        if (!fs.existsSync(mdPath)) continue;
        const head = fs.readFileSync(mdPath, "utf-8").slice(0, 1200);
        const fm = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
          skillsChars += fm[1].length + 24;
          skillsCount++;
        }
      }
    } catch {}
  }
  const skillsTokens = Math.round(skillsChars / 4);

  // 2. Memory / Rules files (AGENTS.md in plugins)
  const memoryFiles = [];
  let memoryTokens = 0;
  if (fs.existsSync(pluginsDir)) {
    try {
      for (const p of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!p.isDirectory()) continue;
        const rulePath = path.join(pluginsDir, p.name, "rules", "AGENTS.md");
        if (fs.existsSync(rulePath)) {
          const st = fs.statSync(rulePath);
          const t = Math.max(1, Math.round(st.size / 4));
          memoryTokens += t;
          memoryFiles.push({ name: `${p.name}/rules/AGENTS.md`, tokens: t });
        }
      }
    } catch {}
  }

  // 3. MCP deferred schemas (~/.gemini/antigravity/mcp/<server>/*.json)
  const mcpDir = path.join(appDir, "mcp");
  const mcpServers = [];
  let mcpDeferredCount = 0;
  let mcpDeferredBytes = 0;
  if (fs.existsSync(mcpDir)) {
    try {
      for (const srv of fs.readdirSync(mcpDir, { withFileTypes: true })) {
        if (!srv.isDirectory()) continue;
        const srvDir = path.join(mcpDir, srv.name);
        let srvBytes = 0;
        let srvTools = 0;
        for (const f of fs.readdirSync(srvDir)) {
          if (f.endsWith(".json")) {
            srvTools++;
            srvBytes += fs.statSync(path.join(srvDir, f)).size;
          }
        }
        mcpDeferredCount += srvTools;
        mcpDeferredBytes += srvBytes;
        if (srvTools > 0) {
          mcpServers.push({ name: srv.name, count: srvTools, tokens: Math.round(srvBytes / 4) });
        }
      }
    } catch {}
  }
  const mcpDeferredTokens = Math.round(mcpDeferredBytes / 4);
  // Active MCP tool names list (~25 tokens per deferred tool name/server stub) + eager tools
  const mcpActiveTokens = mcpDeferredCount * 22;

  // 4. Built-in System tools & System prompt
  const systemToolsTokens = 14800; // ~20 built-in AGY tool schemas
  const systemPromptTokens = 4200; // base system instructions

  const data = {
    skillsTokens,
    skillsCount,
    memoryTokens,
    memoryFiles,
    mcpActiveTokens,
    mcpDeferredTokens,
    mcpDeferredCount,
    mcpServers,
    systemToolsTokens,
    systemPromptTokens,
  };
  envCache = { ts: Date.now(), data };
  return data;
}

let cachedLsConvs = [];
let lsFetchPromise = null;
let lastLsFetchAt = 0;
const metadataCache = new Map();
const transcriptCache = new Map();
const prevRunStateMap = new Map();

function normalizeLsAddr(raw) {
  if (!raw) return "";
  return raw.trim().replace(/^localhost:/i, "127.0.0.1:");
}

function postJsonHttp(addr, pathStr, headers, bodyObj, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const [host, portStr] = addr.split(":");
    const port = parseInt(portStr || "80", 10);
    const payload = JSON.stringify(bodyObj);
    const req = http.request(
      {
        host,
        port,
        path: pathStr,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: JSON.parse(text) });
          } catch (e) {
            resolve({ ok: false, status: res.statusCode, error: e.message });
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "timeout" }); });
    req.on("error", (e) => resolve({ ok: false, error: e.message }));
    req.write(payload);
    req.end();
  });
}

function refreshLsConversations(force = false) {
  if (lsFetchPromise) return lsFetchPromise;
  if (!force && Date.now() - lastLsFetchAt < 1500) return Promise.resolve();
  const lsAddr = normalizeLsAddr(process.env.ANTIGRAVITY_LS_ADDRESS);
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!lsAddr) return Promise.resolve();

  lsFetchPromise = (async () => {
    let ok = false;
    try {
      const resp = await fetch(`http://${lsAddr}/product.v1.ConversationService/ListConversations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          ...(csrf ? { "x-antigravity-csrf-token": csrf } : {}),
        },
        body: JSON.stringify({ pageSize: 20, includeArchived: false }),
        signal: AbortSignal.timeout(8000),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data?.conversations)) {
          cachedLsConvs = data.conversations;
          ok = true;
          lastLsFetchAt = Date.now();
          if (sseClients.size > 0) {
            broadcastAll();
          } else {
            buildSnapshotSync(process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() || "");
          }
        }
      } else {
        console.error("[claude-context-ring] ListConversations HTTP:", resp.status);
      }
    } catch (e) {
      console.error("[claude-context-ring] ListConversations exception:", e.message);
    } finally {
      if (!ok) {
        // Back off ~5s on transient failure so 1s pollers don't storm LS.
        lastLsFetchAt = Date.now() + 3500;
      }
      lsFetchPromise = null;
    }
  })();

  return lsFetchPromise;
}

const wsPendingQueue = [];
let wsInFlightCount = 0;

function drainWorkspaceQueue() {
  while (wsInFlightCount < 2 && wsPendingQueue.length > 0) {
    const convId = wsPendingQueue.shift();
    const entry = metadataCache.get(convId);
    if (!entry) continue;
    const fallback = entry.info || { folderName: "", folderPath: "", branch: "", isSubagent: false };
    wsInFlightCount++;
    runAgentApi(["get-conversation-metadata", convId], 4000)
      .then((res) => {
        let folderName = fallback.folderName;
        let folderPath = fallback.folderPath;
        let branch = fallback.branch;
        let isSubagent = Boolean(fallback.isSubagent);
        let resolved = false;
        if (res.ok && res.data) {
          const meta =
            res.data.response?.conversationMetadata?.metadata ||
            res.data.conversationMetadata?.metadata ||
            {};
          const ws = Array.isArray(meta.workspaces) && meta.workspaces[0];
          const uri =
            ws?.workspaceFolderAbsoluteUri ||
            (Array.isArray(meta.workspaceUris) && meta.workspaceUris[0]) ||
            "";
          if (uri) {
            try {
              folderPath = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
              folderName = path.basename(folderPath) || folderPath;
            } catch {
              folderName = uri;
            }
          }
          branch = ws?.branchName || "";
          isSubagent = Boolean(
            meta.subagentSpec ||
              meta.parentConversationId ||
              (meta.rootConversationId && meta.rootConversationId !== convId)
          );
          resolved = true;
        }
        metadataCache.set(convId, {
          ts: Date.now(),
          ttlMs: resolved && folderPath ? 1800000 : 60000,
          fetching: false,
          info: { folderName, folderPath, branch, isSubagent },
        });
        broadcastAll();
      })
      .finally(() => {
        wsInFlightCount--;
        drainWorkspaceQueue();
      });
  }
}

function ensureWorkspaceInfoAsync(convId) {
  if (!isValidId(convId)) return { folderName: "", folderPath: "", branch: "", isSubagent: false };
  const entry = metadataCache.get(convId);
  const ttl = entry?.ttlMs || 120000;
  if (entry && (entry.fetching || Date.now() - entry.ts < ttl)) {
    return entry.info;
  }
  const fallback = entry?.info || { folderName: "", folderPath: "", branch: "", isSubagent: false };
  metadataCache.set(convId, { ts: entry?.ts || 0, ttlMs: ttl, fetching: true, info: fallback });
  wsPendingQueue.push(convId);
  drainWorkspaceQueue();
  return fallback;
}

function listBrainFallback() {
  const brainDir = path.join(getAppDataDir(), "brain");
  if (!fs.existsSync(brainDir)) return [];
  const items = [];
  for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const p = path.join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
    try {
      const st = fs.statSync(p);
      if (st.isFile()) {
        items.push({
          id: entry.name,
          annotations: { title: "" },
          state: { summary: "", runState: "RUN_STATE_IDLE", updateTime: st.mtime.toISOString() },
          _mtimeMs: st.mtimeMs,
        });
      }
    } catch {}
  }
  items.sort((a, b) => b._mtimeMs - a._mtimeMs);
  return items.slice(0, 10);
}

function extractUserRequestText(rawContent) {
  if (typeof rawContent !== "string") return "";
  const reqMatch = rawContent.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  const body = reqMatch
    ? reqMatch[1]
    : rawContent.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, " ");
  return body.replace(/<\/?USER_REQUEST>/gi, " ").replace(/\s+/g, " ").trim();
}

function parseTranscriptFast(convId, windowSize) {
  const relPath = `.gemini/antigravity/brain/${convId}/.system_generated/logs/transcript.jsonl`;
  const fullPath = path.join(getAppDataDir(), "brain", convId, ".system_generated", "logs", "transcript.jsonl");
  let st;
  try {
    st = fs.statSync(fullPath);
  } catch {
    return {
      found: false,
      relPath,
      totalTokens: 0,
      rawPlannerTokens: 0,
      percentage: 0,
      deltaTokens: 0,
      model: null,
      stepIndex: null,
      latestStepIndex: null,
      compactedSinceLastPlanner: false,
      isSubagent: false,
      firstUserText: "",
      stats: { userTurns: 0, realUserTurns: 0, compactions: 0 },
      categories: [],
      deferred: [],
      details: { mcpServers: [], memoryFiles: [], mcpTotalTokens: 0, mcpCount: 0, memoryTokens: 0, memoryCount: 0 },
    };
  }

  const cached = transcriptCache.get(convId);
  let rawStats;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    rawStats = cached.parsed;
  } else {
    const raw = fs.readFileSync(fullPath, "utf-8");
    const lines = raw.split(/\r?\n/);
    let latestPlanner = null;
    let prevPlanner = null;
    let lastCheckpoint = null;
    let latestStepIndex = null;
    let userTurns = 0;
    let realUserTurns = 0;
    let compactions = 0;
    let firstUserText = "";
    let compactedSinceLastPlanner = false;
    let isSubagent = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (typeof obj.step_index === "number" && (latestStepIndex === null || obj.step_index > latestStepIndex)) {
        latestStepIndex = obj.step_index;
      }
      if (typeof obj.content === "string" && obj.content.includes("<subagent_reminder>")) {
        isSubagent = true;
      }
      if (obj.type === "USER_INPUT") {
        userTurns++;
        const clean = extractUserRequestText(obj.content);
        if (/^\/compact(?:\s|$)/i.test(clean)) {
          compactedSinceLastPlanner = true;
        } else {
          realUserTurns++;
          if (!firstUserText && clean) {
            firstUserText = clean.slice(0, 48);
          }
        }
      }
      const isCheckpoint =
        obj.type === "CHECKPOINT" ||
        (typeof obj.content === "string" &&
          (obj.content.includes("Resuming from a compaction") ||
            obj.content.includes("CHECKPOINT: Resuming from a compaction")));
      if (isCheckpoint) {
        compactions++;
        compactedSinceLastPlanner = true;
        const cpTokens =
          (Number(obj.input_tokens) || 0) +
          (Number(obj.cache_read_tokens) || 0) +
          (Number(obj.output_tokens) || 0);
        lastCheckpoint = {
          stepIndex: typeof obj.step_index === "number" ? obj.step_index : null,
          tokens: cpTokens,
          contentLen: typeof obj.content === "string" ? obj.content.length : 0,
        };
      }
      if (obj.type === "PLANNER_RESPONSE") {
        compactedSinceLastPlanner = false;
        const inp = Number(obj.input_tokens) || 0;
        const cache = Number(obj.cache_read_tokens) || 0;
        const out = Number(obj.output_tokens) || 0;
        prevPlanner = latestPlanner;
        latestPlanner = {
          stepIndex: obj.step_index,
          model: obj.model || "unknown",
          inputTokens: inp,
          cacheReadTokens: cache,
          outputTokens: out,
          contextTokens: inp + cache + out,
        };
      }
    }
    rawStats = {
      latestPlanner,
      prevPlanner,
      lastCheckpoint,
      latestStepIndex,
      userTurns,
      realUserTurns,
      compactions,
      firstUserText,
      compactedSinceLastPlanner,
      isSubagent,
    };
    transcriptCache.set(convId, { mtimeMs: st.mtimeMs, size: st.size, parsed: rawStats });
  }

  const {
    latestPlanner,
    prevPlanner,
    lastCheckpoint,
    latestStepIndex,
    userTurns,
    realUserTurns,
    compactions,
    firstUserText,
    compactedSinceLastPlanner,
    isSubagent,
  } = rawStats;
  const env = getEnvOverhead();
  const envBaseTokens =
    env.systemPromptTokens + env.memoryTokens + env.skillsTokens + env.mcpActiveTokens + env.systemToolsTokens;
  const rawPlannerTokens = latestPlanner ? latestPlanner.contextTokens : 0;

  let totalTokens = rawPlannerTokens;
  if (compactedSinceLastPlanner) {
    if (lastCheckpoint && lastCheckpoint.tokens > 0 && (!rawPlannerTokens || lastCheckpoint.tokens < rawPlannerTokens * 0.6)) {
      totalTokens = lastCheckpoint.tokens;
    } else if (lastCheckpoint) {
      const est = envBaseTokens + Math.max(1500, Math.round(lastCheckpoint.contentLen / 4));
      totalTokens = rawPlannerTokens > 0 ? Math.min(rawPlannerTokens, est) : est;
    } else {
      // /compact USER_INPUT seen while compaction is in progress or awaiting checkpoint
      totalTokens = rawPlannerTokens > 0 ? Math.min(rawPlannerTokens, envBaseTokens + 2000) : envBaseTokens;
    }
  }
  const deltaTokens =
    !compactedSinceLastPlanner && latestPlanner && prevPlanner
      ? latestPlanner.contextTokens - prevPlanner.contextTokens
      : 0;

  // Allocate real overhead up to totalTokens so sum === totalTokens
  let rem = totalTokens;
  const take = (n) => {
    const v = Math.min(rem, Math.max(0, n));
    rem -= v;
    return v;
  };
  const systemPromptTokens = take(env.systemPromptTokens);
  const memoryTokens = take(env.memoryTokens);
  const skillsTokens = take(env.skillsTokens);
  const mcpActiveTokens = take(env.mcpActiveTokens);
  const systemToolsTokens = take(env.systemToolsTokens);
  const messagesTokens = rem; // remainder is actual conversation messages + tool outputs

  const thresholdTokens = Math.round(windowSize * (settings.autoCompactThresholdPct / 100));
  const bufferTokens = Math.max(0, windowSize - thresholdTokens);
  const pct = windowSize > 0 ? Math.round(Math.max(0, Math.min(1, totalTokens / windowSize)) * 100) : 0;

  // Exact Claude Desktop category ordering & palette mapping
  const categories = [
    { name: "messages", display_name: "Messages", tokens: messagesTokens, colorKey: "cat-1" },
    { name: "system_tools", display_name: "System tools", tokens: systemToolsTokens, colorKey: "cat-2" },
    { name: "mcp_tools", display_name: "MCP tools", tokens: mcpActiveTokens, colorKey: "cat-3" },
    { name: "skills", display_name: "Skills", tokens: skillsTokens, colorKey: "cat-4" },
    { name: "system_prompt", display_name: "System prompt", tokens: systemPromptTokens, colorKey: "ref" },
    { name: "memory_files", display_name: "Memory files", tokens: memoryTokens, colorKey: "ref" },
    { name: "autocompact_buffer", display_name: "Autocompact buffer", tokens: bufferTokens, colorKey: "muted" },
  ];

  const deferred = [
    { name: "mcp_deferred", display_name: "MCP tools (deferred)", tokens: env.mcpDeferredTokens, colorKey: "muted" },
  ];

  return {
    found: true,
    relPath,
    totalTokens,
    rawPlannerTokens,
    percentage: pct,
    deltaTokens,
    model: latestPlanner?.model || null,
    stepIndex: latestPlanner?.stepIndex ?? null,
    latestStepIndex,
    compactedSinceLastPlanner: Boolean(compactedSinceLastPlanner),
    isSubagent: Boolean(isSubagent),
    firstUserText,
    stats: { userTurns, realUserTurns, compactions },
    categories,
    deferred,
    details: {
      mcpServers: env.mcpServers,
      memoryFiles: env.memoryFiles,
      mcpTotalTokens: mcpActiveTokens + env.mcpDeferredTokens,
      mcpCount: env.mcpDeferredCount,
      memoryTokens: env.memoryTokens,
      memoryCount: env.memoryFiles.length,
    },
  };
}

let compactStateMtime = 0;

function loadCompactState() {
  const map = new Map();
  try {
    if (fs.existsSync(COMPACT_STATE_PATH)) {
      const st = fs.statSync(COMPACT_STATE_PATH);
      compactStateMtime = st.mtimeMs;
      const obj = JSON.parse(fs.readFileSync(COMPACT_STATE_PATH, "utf-8"));
      if (obj && typeof obj === "object") {
        for (const [k, v] of Object.entries(obj)) {
          if (isValidId(k) && v && typeof v === "object") {
            map.set(k, v.status === "running" ? { ...v, status: "sent" } : v);
          }
        }
      }
    }
  } catch {}
  return map;
}

function saveCompactState(map) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const entries = Array.from(map.entries()).slice(-50);
    const tmp = `${COMPACT_STATE_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries), null, 2), "utf-8");
    fs.renameSync(tmp, COMPACT_STATE_PATH);
    compactStateMtime = fs.statSync(COMPACT_STATE_PATH).mtimeMs;
  } catch {}
}

let compactState = loadCompactState();

function syncCompactStateFromDisk() {
  try {
    if (!fs.existsSync(COMPACT_STATE_PATH)) return;
    const st = fs.statSync(COMPACT_STATE_PATH);
    if (st.mtimeMs > compactStateMtime) {
      compactState = loadCompactState();
    }
  } catch {}
}

function setCompactState(convId, entry) {
  syncCompactStateFromDisk();
  compactState.set(convId, entry);
  saveCompactState(compactState);
}

const AUTO_COMPACT_COOLDOWN_MS = 180000;

async function triggerCompact(convId, stepIndex, reason = "manual", meta = {}) {
  if (!isValidId(convId)) return { ok: false, error: "Invalid conversationId" };
  syncCompactStateFromDisk();
  const prev = compactState.get(convId);
  if (prev?.status === "running") {
    return { ok: false, error: "Compaction already in progress" };
  }
  if (reason !== "manual") {
    // Re-read transcript right before dispatching to prevent any stale-cache race.
    transcriptCache.delete(convId);
    const fresh = parseTranscriptFast(convId, 512000);
    if (!fresh.found || fresh.isSubagent || fresh.compactedSinceLastPlanner) {
      return { ok: false, error: "Skipped auto-compact (already compacted or subagent)" };
    }
    if (prev && prev.lastStep === fresh.stepIndex) {
      return { ok: false, error: "Skipped auto-compact (step already compacted)" };
    }
    if (prev && prev.lastRealUserTurns === fresh.stats.realUserTurns) {
      return { ok: false, error: "Skipped auto-compact (no new user turn since last compaction)" };
    }
    if (prev && prev.lastAt && Date.now() - prev.lastAt < AUTO_COMPACT_COOLDOWN_MS) {
      return { ok: false, error: "Skipped auto-compact (cooldown active)" };
    }
  }
  const lsAddr = normalizeLsAddr(process.env.ANTIGRAVITY_LS_ADDRESS);
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!lsAddr) return { ok: false, error: "ANTIGRAVITY_LS_ADDRESS not set" };

  const realUserTurns = meta.realUserTurns ?? null;
  setCompactState(convId, {
    status: "running",
    lastStep: stepIndex,
    lastRealUserTurns: realUserTurns,
    lastAt: Date.now(),
    reason,
    error: null,
  });
  try {
    const resp = await fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(csrf ? { "x-antigravity-csrf-token": csrf } : {}),
      },
      body: JSON.stringify({
        cascadeId: convId,
        items: [
          {
            item: {
              slashCommand: {
                info: {
                  name: "compact",
                  type: "SLASH_COMMAND_TYPE_SYSTEM",
                },
              },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      setCompactState(convId, {
        status: "sent",
        lastStep: stepIndex,
        lastRealUserTurns: realUserTurns,
        lastAt: Date.now(),
        reason,
        error: null,
      });
      return { ok: true };
    }
    const errText = await resp.text().catch(() => "");
    const msg = `HTTP ${resp.status}${errText ? `: ${errText.slice(0, 120)}` : ""}`;
    setCompactState(convId, {
      status: "error",
      lastStep: stepIndex,
      lastRealUserTurns: realUserTurns,
      lastAt: Date.now(),
      reason,
      error: msg,
    });
    return { ok: false, error: msg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setCompactState(convId, {
      status: "error",
      lastStep: stepIndex,
      lastRealUserTurns: realUserTurns,
      lastAt: Date.now(),
      reason,
      error: msg,
    });
    return { ok: false, error: msg };
  }
}

function buildSnapshotSync(primaryConvId) {
  refreshLsConversations(false);
  syncCompactStateFromDisk();
  const hasLiveLs = cachedLsConvs.length > 0;
  const rawList = hasLiveLs ? cachedLsConvs : listBrainFallback();

  const selected = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || !isValidId(c.id) || seen.has(c.id)) return;
    seen.add(c.id);
    selected.push(c);
  };

  if (primaryConvId && isValidId(primaryConvId)) {
    const match = rawList.find((c) => c.id === primaryConvId);
    add(match || { id: primaryConvId, annotations: { title: "" }, state: { runState: "RUN_STATE_IDLE" } });
  }
  for (const c of rawList) {
    if (selected.length >= MAX_MANAGED_SESSIONS) break;
    if (c.state?.runState === "RUN_STATE_RUNNING") add(c);
  }
  for (const c of rawList) {
    if (selected.length >= MAX_MANAGED_SESSIONS) break;
    add(c);
  }

  const sessions = selected.map((c) => {
    const ws = ensureWorkspaceInfoAsync(c.id);
    const rawMeta = parseTranscriptFast(c.id, 512000);
    const effectiveWindow = getRealModelWindow(rawMeta.model);
    const parsed = parseTranscriptFast(c.id, effectiveWindow);
    const thresholdTokens = Math.round(effectiveWindow * (settings.autoCompactThresholdPct / 100));
    const title =
      c.annotations?.title?.trim() ||
      c.state?.summary?.trim() ||
      parsed.firstUserText ||
      `Conversation ${c.id.slice(0, 8)}`;

    const runState = c.state?.runState || "RUN_STATE_IDLE";
    const isRunning = runState === "RUN_STATE_RUNNING";
    const prevRunState = prevRunStateMap.get(c.id);
    if (hasLiveLs) {
      prevRunStateMap.set(c.id, runState);
    }
    const justStopped = hasLiveLs && prevRunState === "RUN_STATE_RUNNING" && !isRunning;

    const isSubagent = Boolean(
      parsed.isSubagent ||
        ws.isSubagent ||
        c.metadata?.parentConversationId ||
        (c.metadata?.rootConversationId && c.metadata.rootConversationId !== c.id)
    );

    const cs = compactState.get(c.id) || null;
    const sameStepAlreadyCompacted = cs && cs.lastStep === parsed.stepIndex;
    const sameUserTurnAlreadyCompacted = cs && cs.lastRealUserTurns === parsed.stats.realUserTurns;
    const inCooldown = cs && cs.lastAt && Date.now() - cs.lastAt < AUTO_COMPACT_COOLDOWN_MS;

    if (
      settings.autoCompactEnabled &&
      justStopped &&
      !isRunning &&
      !isSubagent &&
      parsed.found &&
      !parsed.compactedSinceLastPlanner &&
      parsed.totalTokens >= thresholdTokens &&
      parsed.stepIndex != null &&
      cs?.status !== "running" &&
      !sameStepAlreadyCompacted &&
      !sameUserTurnAlreadyCompacted &&
      !inCooldown
    ) {
      triggerCompact(c.id, parsed.stepIndex, "auto_on_idle", {
        realUserTurns: parsed.stats.realUserTurns,
      }).catch(() => {});
    }

    return {
      id: c.id,
      shortId: c.id.slice(0, 8),
      title,
      isRunning,
      isSubagent,
      runState,
      folderName: ws.folderName,
      folderPath: ws.folderPath,
      branch: ws.branch,
      relPath: parsed.relPath,
      isCurrent: c.id === primaryConvId,
      windowSize: effectiveWindow,
      thresholdTokens,
      compactStatus: compactState.get(c.id) || null,
      ...parsed,
    };
  });

  const primaryWin = sessions[0]?.windowSize || 512000;
  return {
    settings: { ...settings, windowSize: 0 },
    thresholdTokens: Math.round(primaryWin * (settings.autoCompactThresholdPct / 100)),
    primaryConvId: primaryConvId || (sessions[0]?.id ?? null),
    sessions,
  };
}

function injectTokensIntoHtml(html, token, convId) {
  let out = html;
  if (token) {
    const qs = `token=${encodeURIComponent(token)}` + (convId ? `&conversationId=${encodeURIComponent(convId)}` : "");
    out = out.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (m, attr, q, val) => {
      if (val.startsWith("//")) return m;
      const sep = val.includes("?") ? "&" : "?";
      return `${attr}=${q}${val}${sep}${qs}${q}`;
    });
  }
  const bootstrap = JSON.stringify({ token: token || "", conversationId: convId || "" }).replace(/</g, "\\u003c");
  return out.replace(
    "</head>",
    `  <script>window.__SIDECAR_BOOTSTRAP__=${bootstrap};</script>\n</head>`
  );
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

const sseClients = new Set();

function broadcastAll() {
  for (const client of sseClients) {
    if (client.res.writableEnded || client.res.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      const snap = buildSnapshotSync(client.convId);
      const serialized = JSON.stringify(snap);
      if (serialized !== client.lastSerialized) {
        client.lastSerialized = serialized;
        client.res.write(`data: ${serialized}\n\n`);
      }
    } catch {
      sseClients.delete(client);
    }
  }
}

refreshLsConversations(true);
setInterval(() => {
  if (sseClients.size > 0) {
    broadcastAll();
  } else if (settings.autoCompactEnabled) {
    refreshLsConversations(false);
  }
}, 1500).unref();

const NO_CACHE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
};

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Sidecar-Token");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  const pathname = url.pathname || "/";
  const convId =
    url.searchParams.get("conversationId")?.trim() ||
    url.searchParams.get("conversation_id")?.trim() ||
    process.env.ANTIGRAVITY_CONVERSATION_ID?.trim() ||
    "";
  const reqToken =
    url.searchParams.get("token")?.trim() ||
    (typeof req.headers["x-sidecar-token"] === "string" ? req.headers["x-sidecar-token"].trim() : "");

  if (pathname === "/preload.js") {
    try {
      const p = path.join(getAppDataDir(), "lib", "node_modules", "sidecar_sdk", "preload.js");
      const js = fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : "// preload stub\n";
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", ...NO_CACHE });
      res.end(js);
    } catch {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8", ...NO_CACHE });
      res.end("// preload stub\n");
    }
    return;
  }

  if (pathname === "/" || pathname === "/ui.html") {
    try {
      let html = fs.readFileSync(UI_HTML_PATH, "utf-8");
      html = injectTokensIntoHtml(html, reqToken, convId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...NO_CACHE });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Failed to load ui.html: ${err.message}`);
    }
    return;
  }

  if (pathname === "/api/context") {
    const p = refreshLsConversations(false);
    if (cachedLsConvs.length === 0 && p) {
      await Promise.race([p, new Promise((r) => setTimeout(r, 800))]);
    }
    const snap = buildSnapshotSync(convId);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
    res.end(JSON.stringify(snap));
    return;
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    const body = await readJsonBody(req);
    const next = { ...settings, windowSize: 0 };
    if (typeof body.autoCompactEnabled === "boolean") {
      next.autoCompactEnabled = body.autoCompactEnabled;
    }
    if (Number.isFinite(Number(body.autoCompactThresholdPct))) {
      next.autoCompactThresholdPct = Math.max(10, Math.min(99, Math.round(Number(body.autoCompactThresholdPct))));
    }
    settings = next;
    saveSettings(settings);
    broadcastAll();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
    res.end(JSON.stringify({ ok: true, settings }));
    return;
  }

  if (pathname === "/api/compact" && req.method === "POST") {
    const body = await readJsonBody(req);
    const targetId = (typeof body.conversationId === "string" ? body.conversationId.trim() : "") || convId;
    await refreshLsConversations(true);
    const snap = buildSnapshotSync(convId);
    const target = snap.sessions.find((s) => s.id === targetId);
    if (!target) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
      res.end(JSON.stringify({ ok: false, error: "Session is outside the top 10 managed histories" }));
      return;
    }
    if (target.isRunning) {
      res.writeHead(409, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
      res.end(JSON.stringify({ ok: false, error: "Cannot compact while conversation is running" }));
      return;
    }
    const parsed = parseTranscriptFast(targetId, target.windowSize || 512000);
    const result = await triggerCompact(targetId, parsed.stepIndex, "manual", {
      realUserTurns: parsed.stats.realUserTurns,
    });
    broadcastAll();
    res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8", ...NO_CACHE });
    res.end(JSON.stringify(result));
    return;
  }

  if (pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const snap = buildSnapshotSync(convId);
    const serialized = JSON.stringify(snap);
    res.write(`data: ${serialized}\n\n`);

    const client = { res, convId, lastSerialized: serialized };
    sseClients.add(client);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(maxLifeTimer);
      sseClients.delete(client);
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch {}
      }
    };
    const maxLifeTimer = setTimeout(cleanup, 30000);
    maxLifeTimer.unref();
    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("error", cleanup);
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found" }));
});

server.listen(PORT, HOST, () => {
  console.log(`[claude-context-ring] listening on http://${HOST}:${PORT}`);
});

function shutdown() {
  for (const client of sseClients) {
    try { client.res.end(); } catch {}
  }
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
