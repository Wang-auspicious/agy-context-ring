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

const DEFAULT_SETTINGS = {
  windowSize: 256000, // 256000 | 512000 | 1000000
  autoCompactEnabled: false,
  autoCompactThresholdPct: 60, // 1..99
};

function getAppDataDir() {
  const envDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  if (envDir) return envDir;
  return path.join(os.homedir(), ".gemini", "antigravity");
}

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
      return {
        windowSize: [256000, 512000, 1000000].includes(Number(parsed.windowSize))
          ? Number(parsed.windowSize)
          : DEFAULT_SETTINGS.windowSize,
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
  if (envExe) return { file: envExe, prefix: path.basename(envExe).toLowerCase().startsWith("agentapi") ? [] : ["agentapi"] };
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

// Cache workspace folder metadata per conversationId
const metadataCache = new Map();
async function getWorkspaceInfo(convId) {
  if (!isValidId(convId)) return { folderName: "", folderPath: "", branch: "" };
  const cached = metadataCache.get(convId);
  if (cached && Date.now() - cached.ts < 60000) return cached.info;

  const res = await runAgentApi(["get-conversation-metadata", convId], 8000);
  let folderName = "";
  let folderPath = "";
  let branch = "";
  if (res.ok && res.data) {
    const meta = res.data.response?.conversationMetadata?.metadata || res.data.conversationMetadata?.metadata || {};
    const ws = Array.isArray(meta.workspaces) && meta.workspaces[0];
    const uri = ws?.workspaceFolderAbsoluteUri || (Array.isArray(meta.workspaceUris) && meta.workspaceUris[0]) || "";
    if (uri) {
      try {
        folderPath = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ""));
        folderName = path.basename(folderPath) || folderPath;
      } catch {
        folderName = uri;
      }
    }
    branch = ws?.branchName || "";
  }
  const info = { folderName, folderPath, branch };
  metadataCache.set(convId, { ts: Date.now(), info });
  return info;
}

// List conversations via ConversationService/ListConversations, with brain/ fallback
async function listConversationsFromLS() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS?.trim();
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN?.trim();
  if (!lsAddr) return null;
  try {
    const resp = await fetch(`http://${lsAddr}/product.v1.ConversationService/ListConversations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        ...(csrf ? { "x-antigravity-csrf-token": csrf } : {}),
      },
      body: JSON.stringify({ pageSize: 20, includeArchived: false }),
      signal: AbortSignal.timeout(4000),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    return Array.isArray(json.conversations) ? json.conversations : null;
  } catch {
    return null;
  }
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
  return items.slice(0, 12);
}

function parseTranscript(convId, windowSize) {
  const relPath = `brain/${convId}/.system_generated/logs/transcript.jsonl`;
  const fullPath = path.join(getAppDataDir(), relPath);
  if (!fs.existsSync(fullPath)) {
    return {
      found: false,
      relPath,
      totalTokens: 0,
      percentage: 0,
      deltaTokens: 0,
      model: null,
      stepIndex: null,
      stats: { userTurns: 0, compactions: 0 },
      categories: [],
    };
  }

  const raw = fs.readFileSync(fullPath, "utf-8");
  const lines = raw.split(/\r?\n/);

  let latestPlanner = null;
  let prevPlanner = null;
  let userTurns = 0;
  let compactions = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj.type === "USER_INPUT") userTurns++;
    if (typeof obj.content === "string" && obj.content.includes("CHECKPOINT: Resuming from a compaction")) {
      compactions++;
    }
    if (obj.type === "PLANNER_RESPONSE") {
      const inp = Number(obj.input_tokens) || 0;
      const cache = Number(obj.cache_read_tokens) || 0;
      const out = Number(obj.output_tokens) || 0;
      prevPlanner = latestPlanner;
      latestPlanner = {
        stepIndex: obj.step_index,
        createdAt: obj.created_at || null,
        model: obj.model || "unknown",
        inputTokens: inp,
        cacheReadTokens: cache,
        outputTokens: out,
        contextTokens: inp + cache + out,
      };
    }
  }

  const totalTokens = latestPlanner ? latestPlanner.contextTokens : 0;
  const cacheTokens = latestPlanner ? latestPlanner.cacheReadTokens : 0;
  const inputTokens = latestPlanner ? latestPlanner.inputTokens : 0;
  const outputTokens = latestPlanner ? latestPlanner.outputTokens : 0;
  const deltaTokens =
    latestPlanner && prevPlanner ? latestPlanner.contextTokens - prevPlanner.contextTokens : 0;
  const pct = windowSize > 0 ? Math.round(Math.max(0, Math.min(1, totalTokens / windowSize)) * 100) : 0;

  return {
    found: true,
    relPath,
    totalTokens,
    percentage: pct,
    deltaTokens,
    model: latestPlanner?.model || null,
    stepIndex: latestPlanner?.stepIndex ?? null,
    stats: { userTurns, compactions },
    categories: [
      { name: "cache_read", display_name: "Cached context", tokens: cacheTokens },
      { name: "input", display_name: "Uncached input", tokens: inputTokens },
      { name: "output", display_name: "Model output", tokens: outputTokens },
    ],
  };
}

// Track compaction triggers so we don't spam the same step
const compactState = new Map(); // convId -> { status, lastStep, lastAt, error }

async function triggerCompact(convId, stepIndex, reason = "manual") {
  if (!isValidId(convId)) return { ok: false, error: "Invalid conversationId" };
  const prev = compactState.get(convId);
  if (prev?.status === "running") {
    return { ok: false, error: "Compaction already in progress" };
  }
  compactState.set(convId, { status: "running", lastStep: stepIndex, lastAt: Date.now(), reason, error: null });
  const res = await runAgentApi(["send-message", "--title=Context Compaction", convId, "/compact"], 20000);
  if (res.ok) {
    compactState.set(convId, { status: "sent", lastStep: stepIndex, lastAt: Date.now(), reason, error: null });
    return { ok: true };
  }
  compactState.set(convId, { status: "error", lastStep: stepIndex, lastAt: Date.now(), reason, error: res.error || "Failed" });
  return { ok: false, error: res.error || "Failed to send /compact" };
}

async function buildSnapshot(primaryConvId) {
  const lsConvs = await listConversationsFromLS();
  const rawList = lsConvs && lsConvs.length > 0 ? lsConvs : listBrainFallback();

  // Prioritize: running sessions + primaryConvId + most recent idle sessions (up to 6)
  const running = rawList.filter((c) => c.state?.runState === "RUN_STATE_RUNNING");
  const others = rawList.filter((c) => c.state?.runState !== "RUN_STATE_RUNNING");

  const selected = [];
  const seen = new Set();
  const add = (c) => {
    if (!c || !isValidId(c.id) || seen.has(c.id)) return;
    seen.add(c.id);
    selected.push(c);
  };

  for (const c of running) add(c);
  if (primaryConvId) {
    const match = rawList.find((c) => c.id === primaryConvId);
    if (match) add(match);
    else if (isValidId(primaryConvId)) {
      add({ id: primaryConvId, annotations: { title: "Current Session" }, state: { runState: "RUN_STATE_RUNNING" } });
    }
  }
  for (const c of others) {
    if (selected.length >= 6) break;
    add(c);
  }

  const sessions = await Promise.all(
    selected.map(async (c) => {
      const ws = await getWorkspaceInfo(c.id);
      const parsed = parseTranscript(c.id, settings.windowSize);
      const title = c.annotations?.title?.trim() || c.state?.summary?.trim() || `Session ${c.id.slice(0, 8)}`;
      const isRunning = c.state?.runState === "RUN_STATE_RUNNING";
      const cs = compactState.get(c.id) || null;

      // Auto-compact check (only when enabled, session has data, and threshold reached)
      const thresholdTokens = Math.round(settings.windowSize * (settings.autoCompactThresholdPct / 100));
      if (
        settings.autoCompactEnabled &&
        parsed.found &&
        parsed.totalTokens >= thresholdTokens &&
        parsed.stepIndex != null &&
        cs?.lastStep !== parsed.stepIndex &&
        cs?.status !== "running" &&
        (!cs?.lastAt || Date.now() - cs.lastAt > 30000)
      ) {
        triggerCompact(c.id, parsed.stepIndex, "auto").catch(() => {});
      }

      return {
        id: c.id,
        shortId: c.id.slice(0, 8),
        title,
        isRunning,
        runState: c.state?.runState || "RUN_STATE_IDLE",
        folderName: ws.folderName,
        folderPath: ws.folderPath,
        branch: ws.branch,
        relPath: parsed.relPath,
        isCurrent: c.id === primaryConvId,
        compactStatus: compactState.get(c.id) || null,
        ...parsed,
      };
    })
  );

  return {
    settings,
    thresholdTokens: Math.round(settings.windowSize * (settings.autoCompactThresholdPct / 100)),
    primaryConvId: primaryConvId || (sessions[0]?.id ?? null),
    sessions,
  };
}

function injectTokensIntoHtml(html, token, convId) {
  if (!token) return html;
  const qs = `token=${encodeURIComponent(token)}` + (convId ? `&conversationId=${encodeURIComponent(convId)}` : "");
  return html.replace(/\b(href|src)=(["'])(\/[^"'\s>]*)\2/g, (m, attr, q, val) => {
    if (val.startsWith("//")) return m;
    const sep = val.includes("?") ? "&" : "?";
    return `${attr}=${q}${val}${sep}${qs}${q}`;
  });
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

async function broadcastAll() {
  for (const client of sseClients) {
    if (client.res.writableEnded || client.res.destroyed) {
      sseClients.delete(client);
      continue;
    }
    try {
      const snap = await buildSnapshot(client.convId);
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

setInterval(() => {
  if (sseClients.size > 0) broadcastAll();
}, 1200).unref();

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

  if (pathname === "/" || pathname === "/ui.html") {
    try {
      let html = fs.readFileSync(UI_HTML_PATH, "utf-8");
      html = injectTokensIntoHtml(html, reqToken || TOKEN, convId);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`Failed to load ui.html: ${err.message}`);
    }
    return;
  }

  if (pathname === "/api/context") {
    const snap = await buildSnapshot(convId);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(snap));
    return;
  }

  if (pathname === "/api/settings" && req.method === "POST") {
    const body = await readJsonBody(req);
    const next = { ...settings };
    if ([256000, 512000, 1000000].includes(Number(body.windowSize))) {
      next.windowSize = Number(body.windowSize);
    }
    if (typeof body.autoCompactEnabled === "boolean") {
      next.autoCompactEnabled = body.autoCompactEnabled;
    }
    if (Number.isFinite(Number(body.autoCompactThresholdPct))) {
      next.autoCompactThresholdPct = Math.max(10, Math.min(99, Math.round(Number(body.autoCompactThresholdPct))));
    }
    settings = next;
    saveSettings(settings);
    broadcastAll();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, settings }));
    return;
  }

  if (pathname === "/api/compact" && req.method === "POST") {
    const body = await readJsonBody(req);
    const targetId = (typeof body.conversationId === "string" ? body.conversationId.trim() : "") || convId;
    const parsed = parseTranscript(targetId, settings.windowSize);
    const result = await triggerCompact(targetId, parsed.stepIndex, "manual");
    broadcastAll();
    res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
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
    const snap = await buildSnapshot(convId);
    const serialized = JSON.stringify(snap);
    res.write(`data: ${serialized}\n\n`);

    const client = { res, convId, lastSerialized: serialized };
    sseClients.add(client);
    const cleanup = () => sseClients.delete(client);
    req.on("close", cleanup);
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
