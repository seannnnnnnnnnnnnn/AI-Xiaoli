const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile, spawn } = require("node:child_process");
const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  ipcMain,
  nativeImage,
  session,
  screen,
  safeStorage
} = require("electron");

const APP_NAME = "AI小力";
const APP_SUBTITLE = "桌面 AI 任务助手";
const LEGACY_APP_NAME = "AI小力桌宠";
const APP_LOGO_PATH = path.join(__dirname, "assets", "app-logo.png");
const REMINDER_POLL_MS = 15000;
const MASCOT_INTERACTION_POLL_MS = 50;
const ACTIVITY_POLL_MS = 30000;
const DEFAULT_SNOOZE_MINUTES = 10;
const MASCOT_SIZE = { width: 480, height: 680 };
const MIN_MASCOT_SCALE = 0.7;
const MAX_MASCOT_SCALE = 1.45;
const SETTINGS_SIZE = { width: 1160, height: 820 };
const SUMMARY_HISTORY_LIMIT = 60;
const VALID_REPEATS = new Set(["none", "daily", "weekly", "monthly"]);
const FUTURE_DUE_GRACE_MS = 1000;
const JUST_NOW_START_TIMEOUT_MS = 12000;
const JUST_NOW_STOP_TIMEOUT_MS = 150000;
const DEFAULT_SUMMARY_TEMPLATE = {
  id: "default",
  name: "默认复盘模板",
  body: [
    "# 复盘要求",
    "",
    "- 基于真实活动日志和提醒记录总结，不要编造。",
    "- 先给总体判断，再列时间线、主要成果、注意力分布和待跟进建议。",
    "- 如果数据不足，要明确指出缺口。",
    "- 输出适合在桌面应用内阅读的中文 HTML 复盘卡片。"
  ].join("\n"),
  builtIn: true
};
const DEFAULT_JUST_NOW_TEMPLATE = [
  "# 刚刚发生了啥",
  "",
  "- 根据转写内容，提炼刚刚发生的关键事项。",
  "- 按事实总结，不要编造。",
  "- 输出：一句话结论、关键时间线、已决定事项、待跟进任务、可能遗漏。",
  "- 如果转写混乱或信息不足，要明确指出。",
  "- 输出适合在桌面应用内阅读的中文 HTML 复盘卡片。"
].join("\n");

let mascotWindow = null;
let settingsWindow = null;
let tray = null;
let reminderTimer = null;
let checkingReminders = false;
let saveBoundsTimer = null;
let mousePollTimer = null;
let mousePassthroughEnabled = null;
let mascotDragState = null;
let mascotBubbleInteractive = false;
let activityTimer = null;
let currentForeground = null;
let lastForegroundErrorAt = 0;
let lastActivityTrimAt = 0;
let activeReminderPayload = null;
let nativeJustNowSession = null;

const defaultSettings = {
  paused: false,
  autoLaunch: false,
  mascotVisible: true,
  mascotScale: 1,
  notificationBarPinned: false,
  ai: {
    enabled: false,
    baseUrl: "",
    model: "",
    chatPath: "/v1/chat/completions",
    activityTracking: false,
    retentionDays: 30,
    updatedAt: ""
  },
  mascotBounds: null,
  updatedAt: ""
};

let settings = { ...defaultSettings };
let reminders = [];

app.setName(APP_NAME);
app.setAppUserModelId("ai.xiaoli.mascot");

function migrateLegacyUserData() {
  const currentDir = app.getPath("userData");
  const legacyDir = path.join(app.getPath("appData"), LEGACY_APP_NAME);
  if (currentDir === legacyDir || !fs.existsSync(legacyDir)) return;
  fs.mkdirSync(currentDir, { recursive: true });
  for (const filename of [
    "settings.json",
    "reminders.json",
    "activity.jsonl",
    "ai-key.json",
    "summary-templates.json",
    "summary-history.json",
    "just-now-template.md",
    "just-now-history.json"
  ]) {
    const from = path.join(legacyDir, filename);
    const to = path.join(currentDir, filename);
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to);
    }
  }
}

function dataPath(filename) {
  return path.join(app.getPath("userData"), filename);
}

function readJson(filename, fallback) {
  const filePath = dataPath(filename);
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed;
  } catch {
    return fallback;
  }
}

function writeJson(filename, value) {
  const filePath = dataPath(filename);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function aiKeyPath() {
  return dataPath("ai-key.json");
}

function readAiApiKey() {
  const filePath = aiKeyPath();
  try {
    if (!fs.existsSync(filePath)) return "";
    const stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!stored || typeof stored !== "object") return "";
    if (stored.mode === "safeStorage") {
      const encrypted = Buffer.from(String(stored.value || ""), "base64");
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : "";
    }
    if (stored.mode === "plain") {
      return Buffer.from(String(stored.value || ""), "base64").toString("utf8");
    }
  } catch {
    return "";
  }
  return "";
}

function writeAiApiKey(apiKey) {
  const filePath = aiKeyPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const value = String(apiKey || "").trim();
  if (!value) {
    fs.rmSync(filePath, { force: true });
    return;
  }
  const payload = safeStorage.isEncryptionAvailable()
    ? {
        mode: "safeStorage",
        value: safeStorage.encryptString(value).toString("base64")
      }
    : {
        mode: "plain",
        value: Buffer.from(value, "utf8").toString("base64")
      };
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function activityLogPath() {
  return dataPath("activity.jsonl");
}

function summaryTemplatesPath() {
  return dataPath("summary-templates.json");
}

function summaryHistoryPath() {
  return dataPath("summary-history.json");
}

function justNowTemplatePath() {
  return dataPath("just-now-template.md");
}

function justNowHistoryPath() {
  return dataPath("just-now-history.json");
}

function justNowDebugDir() {
  return dataPath("just-now-debug");
}

function normalizeSummaryTemplate(template) {
  if (!template || typeof template !== "object") return null;
  const name = String(template.name || "").trim().slice(0, 80);
  const body = String(template.body || "").trim().slice(0, 8000);
  if (!name || !body) return null;
  const nowIso = new Date().toISOString();
  return {
    id: String(template.id || crypto.randomUUID()),
    name,
    body,
    builtIn: false,
    createdAt: template.createdAt || nowIso,
    updatedAt: nowIso
  };
}

function readCustomSummaryTemplates() {
  try {
    const filePath = summaryTemplatesPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeSummaryTemplate).filter(Boolean);
  } catch {
    return [];
  }
}

function writeCustomSummaryTemplates(templates) {
  const normalized = Array.isArray(templates)
    ? templates.map(normalizeSummaryTemplate).filter(Boolean)
    : [];
  fs.mkdirSync(path.dirname(summaryTemplatesPath()), { recursive: true });
  fs.writeFileSync(summaryTemplatesPath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function summaryTemplates() {
  return [
    { ...DEFAULT_SUMMARY_TEMPLATE },
    ...readCustomSummaryTemplates()
  ];
}

function saveSummaryTemplate(input = {}) {
  const customTemplates = readCustomSummaryTemplates();
  const existing = customTemplates.find((item) => item.id === input.id);
  const template = normalizeSummaryTemplate({
    ...input,
    id: input.id && input.id !== "default" ? input.id : crypto.randomUUID(),
    createdAt: existing?.createdAt
  });
  if (!template) throw new Error("请填写模板名称和 Markdown 内容。");
  const nextTemplates = existing
    ? customTemplates.map((item) => (item.id === template.id ? template : item))
    : [...customTemplates, template];
  writeCustomSummaryTemplates(nextTemplates);
  return template;
}

function deleteSummaryTemplate(id) {
  const targetId = String(id || "");
  if (!targetId || targetId === "default") throw new Error("默认模板不能删除。");
  writeCustomSummaryTemplates(readCustomSummaryTemplates().filter((item) => item.id !== targetId));
  return true;
}

function resolveSummaryTemplate(id) {
  const targetId = String(id || "default");
  return summaryTemplates().find((template) => template.id === targetId) || { ...DEFAULT_SUMMARY_TEMPLATE };
}

function normalizeSummaryHistoryEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const nowIso = new Date().toISOString();
  const createdAtDate = entry.createdAt ? new Date(entry.createdAt) : null;
  const createdAt = createdAtDate && Number.isFinite(createdAtDate.getTime())
    ? createdAtDate.toISOString()
    : nowIso;
  const range = entry.range && typeof entry.range === "object" ? entry.range : {};
  const template = entry.template && typeof entry.template === "object" ? entry.template : {};
  const rangeLabel = String(range.label || "复盘").trim() || "复盘";
  return {
    id: String(entry.id || crypto.randomUUID()),
    title: String(entry.title || `${rangeLabel}智能复盘`).trim().slice(0, 120) || `${rangeLabel}智能复盘`,
    summary: String(entry.summary || "").slice(0, 60000),
    html: String(entry.html || "").slice(0, 120000),
    localSummary: String(entry.localSummary || "").slice(0, 60000),
    range: {
      label: rangeLabel,
      start: String(range.start || ""),
      end: String(range.end || "")
    },
    template: {
      id: String(template.id || "default"),
      name: String(template.name || "默认复盘模板").slice(0, 80)
    },
    stats: entry.stats && typeof entry.stats === "object" ? entry.stats : {},
    fromModel: Boolean(entry.fromModel),
    warning: String(entry.warning || "").slice(0, 400),
    prompt: String(entry.prompt || "").slice(0, 1000),
    createdAt
  };
}

function readSummaryHistory() {
  try {
    const filePath = summaryHistoryPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeSummaryHistoryEntry)
      .filter(Boolean)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [];
  }
}

function writeSummaryHistory(entries) {
  const normalized = Array.isArray(entries)
    ? entries.map(normalizeSummaryHistoryEntry).filter(Boolean).slice(0, SUMMARY_HISTORY_LIMIT)
    : [];
  fs.mkdirSync(path.dirname(summaryHistoryPath()), { recursive: true });
  fs.writeFileSync(summaryHistoryPath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function saveSummaryHistoryEntry(entry) {
  const normalized = normalizeSummaryHistoryEntry({
    ...entry,
    id: entry.id || crypto.randomUUID(),
    createdAt: entry.createdAt || new Date().toISOString()
  });
  if (!normalized) throw new Error("复盘历史内容无效。");
  const nextEntries = [
    normalized,
    ...readSummaryHistory().filter((item) => item.id !== normalized.id)
  ].slice(0, SUMMARY_HISTORY_LIMIT);
  writeSummaryHistory(nextEntries);
  return normalized;
}

function publicSummaryHistory() {
  return readSummaryHistory().map((entry) => ({
    id: entry.id,
    title: entry.title,
    range: entry.range,
    template: entry.template,
    fromModel: entry.fromModel,
    warning: entry.warning,
    createdAt: entry.createdAt
  }));
}

function getSummaryHistoryEntry(id) {
  const targetId = String(id || "");
  if (!targetId) return null;
  return readSummaryHistory().find((entry) => entry.id === targetId) || null;
}

function persistSummaryResult(result = {}, input = {}) {
  const rangeLabel = result.range?.label || "复盘";
  const saved = saveSummaryHistoryEntry({
    ...result,
    title: `${rangeLabel}智能复盘`,
    prompt: String(input.prompt || "").trim()
  });
  return {
    ...result,
    historyId: saved.id,
    historyCreatedAt: saved.createdAt
  };
}

function readJustNowTemplate() {
  try {
    const filePath = justNowTemplatePath();
    if (!fs.existsSync(filePath)) return DEFAULT_JUST_NOW_TEMPLATE;
    const text = fs.readFileSync(filePath, "utf8").trim();
    return text || DEFAULT_JUST_NOW_TEMPLATE;
  } catch {
    return DEFAULT_JUST_NOW_TEMPLATE;
  }
}

function writeJustNowTemplate(markdown) {
  const body = String(markdown || "").trim().slice(0, 8000);
  if (!body) throw new Error("模板内容不能为空。");
  fs.mkdirSync(path.dirname(justNowTemplatePath()), { recursive: true });
  fs.writeFileSync(justNowTemplatePath(), `${body}\n`, "utf8");
  return { body, updatedAt: new Date().toISOString() };
}

function normalizeJustNowEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const nowIso = new Date().toISOString();
  const createdAtDate = entry.createdAt ? new Date(entry.createdAt) : null;
  const createdAt = createdAtDate && Number.isFinite(createdAtDate.getTime())
    ? createdAtDate.toISOString()
    : nowIso;
  const updatedAtDate = entry.updatedAt ? new Date(entry.updatedAt) : null;
  const summarizedAtDate = entry.summarizedAt ? new Date(entry.summarizedAt) : null;
  const status = entry.status === "transcribed" ? "transcribed" : "summarized";
  return {
    id: String(entry.id || crypto.randomUUID()),
    title: String(entry.title || "刚刚发生了啥").trim().slice(0, 120) || "刚刚发生了啥",
    transcript: String(entry.transcript || "").trim().slice(0, 80000),
    editedTranscript: String(entry.editedTranscript || entry.transcript || "").trim().slice(0, 80000),
    summary: String(entry.summary || "").slice(0, 60000),
    html: String(entry.html || "").slice(0, 120000),
    template: String(entry.template || "").slice(0, 8000),
    durationMs: Math.max(0, Number.parseInt(String(entry.durationMs || 0), 10) || 0),
    transcriptionSource: String(entry.transcriptionSource || "").slice(0, 40),
    status,
    fromModel: Boolean(entry.fromModel),
    warning: String(entry.warning || "").slice(0, 500),
    createdAt,
    updatedAt: updatedAtDate && Number.isFinite(updatedAtDate.getTime()) ? updatedAtDate.toISOString() : createdAt,
    summarizedAt: summarizedAtDate && Number.isFinite(summarizedAtDate.getTime()) ? summarizedAtDate.toISOString() : ""
  };
}

function readJustNowHistory() {
  try {
    const filePath = justNowHistoryPath();
    if (!fs.existsSync(filePath)) return [];
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeJustNowEntry)
      .filter(Boolean)
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
  } catch {
    return [];
  }
}

function writeJustNowHistory(entries) {
  const normalized = Array.isArray(entries)
    ? entries.map(normalizeJustNowEntry).filter(Boolean).slice(0, SUMMARY_HISTORY_LIMIT)
    : [];
  fs.mkdirSync(path.dirname(justNowHistoryPath()), { recursive: true });
  fs.writeFileSync(justNowHistoryPath(), `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
}

function saveJustNowEntry(entry) {
  const normalized = normalizeJustNowEntry({
    ...entry,
    id: entry.id || crypto.randomUUID(),
    createdAt: entry.createdAt || new Date().toISOString()
  });
  if (!normalized || !normalized.transcript) throw new Error("刚刚发生了啥的转写内容为空。");
  const nextEntries = [
    normalized,
    ...readJustNowHistory().filter((item) => item.id !== normalized.id)
  ].slice(0, SUMMARY_HISTORY_LIMIT);
  writeJustNowHistory(nextEntries);
  return normalized;
}

function publicJustNowHistory() {
  return readJustNowHistory().map((entry) => ({
    id: entry.id,
    title: entry.title,
    durationMs: entry.durationMs,
    status: entry.status,
    fromModel: entry.fromModel,
    warning: entry.warning,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    summarizedAt: entry.summarizedAt
  }));
}

function getJustNowEntry(id) {
  const targetId = String(id || "");
  if (!targetId) return null;
  return readJustNowHistory().find((entry) => entry.id === targetId) || null;
}

function saveJustNowDraft(input = {}) {
  const transcript = String(input.transcript || "").trim();
  if (!transcript) throw new Error("刚刚发生了啥的转写内容为空。");
  const nowIso = new Date().toISOString();
  const saved = saveJustNowEntry({
    id: input.id || crypto.randomUUID(),
    title: input.title || "刚刚发生了啥",
    transcript,
    editedTranscript: transcript,
    summary: "转写草稿已保存，等待确认后生成复盘。",
    html: "",
    template: readJustNowTemplate(),
    durationMs: input.durationMs,
    transcriptionSource: input.transcriptionSource || "macos-speech",
    status: "transcribed",
    fromModel: false,
    warning: "转写已保存，确认或编辑后再生成复盘。",
    createdAt: input.createdAt || nowIso,
    updatedAt: nowIso
  });
  return saved;
}

function nativeSpeechHelperPath() {
  const unpackedPath = path.join(process.resourcesPath || "", "app.asar.unpacked", "native", "xiaoli-speech");
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  return path.join(__dirname, "native", "xiaoli-speech");
}

function nativeSpeechHelperSourcePath() {
  const unpackedPath = path.join(process.resourcesPath || "", "app.asar.unpacked", "scripts", "xiaoli-speech.swift");
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  return path.join(__dirname, "scripts", "xiaoli-speech.swift");
}

function nativeSpeechHelperInfoPath() {
  const unpackedPath = path.join(process.resourcesPath || "", "app.asar.unpacked", "scripts", "xiaoli-speech-info.plist");
  if (fs.existsSync(unpackedPath)) return unpackedPath;
  return path.join(__dirname, "scripts", "xiaoli-speech-info.plist");
}

function execFilePromise(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function nativeSpeechCompileArgs(sourcePath, helperPath) {
  const args = ["swiftc", "-O", sourcePath];
  const infoPath = nativeSpeechHelperInfoPath();
  if (fs.existsSync(infoPath)) {
    args.push(
      "-Xlinker",
      "-sectcreate",
      "-Xlinker",
      "__TEXT",
      "-Xlinker",
      "__info_plist",
      "-Xlinker",
      infoPath
    );
  }
  args.push(
    "-framework",
    "Speech",
    "-framework",
    "AVFoundation",
    "-o",
    helperPath
  );
  return args;
}

async function ensureNativeSpeechHelper() {
  if (process.platform !== "darwin") {
    throw new Error("macOS 系统转写只支持 macOS。");
  }
  const helperPath = nativeSpeechHelperPath();
  if (fs.existsSync(helperPath)) return helperPath;
  const sourcePath = nativeSpeechHelperSourcePath();
  if (!fs.existsSync(sourcePath)) {
    throw new Error("找不到 macOS 系统转写组件。");
  }
  fs.mkdirSync(path.dirname(helperPath), { recursive: true });
  await execFilePromise("xcrun", nativeSpeechCompileArgs(sourcePath, helperPath), { timeout: 60000 });
  fs.chmodSync(helperPath, 0o755);
  return helperPath;
}

function justNowErrorMessage(error, fallback = "刚刚发生了啥执行失败。") {
  const message = String(error?.message || error || "").trim();
  return message || fallback;
}

function appendJustNowError(stage, error, meta = {}) {
  try {
    appendActivity({
      type: "just_now.error",
      title: "刚刚发生了啥失败",
      source: APP_NAME,
      detail: justNowErrorMessage(error),
      meta: {
        stage,
        message: justNowErrorMessage(error),
        ...meta
      }
    });
  } catch {}
}

function nativeSpeechExitMessage(sessionState, code, signal) {
  const directMessage = String(sessionState.error || "").trim();
  if (directMessage) return directMessage;
  const stderr = String(sessionState.stderr || "").trim();
  if (stderr) return stderr.slice(0, 1000);
  if (code === 134) {
    return "macOS 隐私系统拦截了语音转写组件。请使用最新版 AI小力，并在系统设置里允许麦克风和语音识别权限。";
  }
  return `macOS 系统转写组件异常退出${code === null ? "" : `，退出码 ${code}`}${signal ? `，信号 ${signal}` : ""}。`;
}

function parseSpeechHelperLine(line, session) {
  let payload = null;
  try {
    payload = JSON.parse(line);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;
  if (payload.event === "ready" || payload.event === "diagnostic" || payload.event === "final") {
    session.diagnostics = {
      ...(session.diagnostics || {}),
      ...payload
    };
  }
  if (payload.transcript) session.transcript = String(payload.transcript).trim();
  if (payload.event === "ready") {
    session.ready = true;
    session.resolveReady?.({
      startedAt: session.startedAt,
      transcriptionSource: "macos-speech",
      inputDevice: payload.inputDevice || ""
    });
  }
  if (payload.event === "final") {
    session.final = true;
    session.resolveFinal?.(session.transcript);
  }
  if (payload.event === "error") {
    const message = String(payload.message || "macOS 系统转写失败。");
    session.error = message;
    if (!session.ready) session.rejectReady?.(new Error(message));
    else if (!session.transcript) session.rejectFinal?.(new Error(message));
  }
}

async function startNativeJustNowRecording() {
  if (nativeJustNowSession) return {
    startedAt: nativeJustNowSession.startedAt,
    transcriptionSource: "macos-speech"
  };
  let helperPath = "";
  try {
    helperPath = await ensureNativeSpeechHelper();
  } catch (error) {
    appendJustNowError("prepare", error);
    throw error;
  }
  const debugDir = justNowDebugDir();
  fs.mkdirSync(debugDir, { recursive: true });
  const child = spawn(helperPath, ["--locale", "zh-CN", "--debug-dir", debugDir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      LC_ALL: "zh_CN.UTF-8"
    }
  });
  const sessionState = {
    child,
    startedAt: Date.now(),
    transcript: "",
    stderr: "",
    diagnostics: {},
    ready: false,
    final: false,
    buffer: "",
    error: ""
  };
  nativeJustNowSession = sessionState;

  sessionState.readyPromise = new Promise((resolve, reject) => {
    sessionState.resolveReady = resolve;
    sessionState.rejectReady = reject;
  });
  sessionState.finalPromise = new Promise((resolve, reject) => {
    sessionState.resolveFinal = resolve;
    sessionState.rejectFinal = reject;
  });

  child.stdout.on("data", (chunk) => {
    sessionState.buffer += chunk.toString("utf8");
    const lines = sessionState.buffer.split(/\r?\n/);
    sessionState.buffer = lines.pop() || "";
    lines.filter(Boolean).forEach((line) => parseSpeechHelperLine(line, sessionState));
  });
  child.stderr.on("data", (chunk) => {
    sessionState.stderr += chunk.toString("utf8");
  });
  child.on("error", (error) => {
    const message = error?.message || "无法启动 macOS 系统转写。";
    sessionState.error = message;
    sessionState.rejectReady?.(new Error(message));
    sessionState.rejectFinal?.(new Error(message));
  });
  child.on("exit", (code, signal) => {
    sessionState.exitCode = code;
    sessionState.exitSignal = signal || "";
    if (nativeJustNowSession === sessionState) nativeJustNowSession = null;
    if (!sessionState.ready) {
      sessionState.rejectReady?.(new Error(nativeSpeechExitMessage(sessionState, code, signal)));
      return;
    }
    if (!sessionState.final) {
      if (sessionState.transcript) sessionState.resolveFinal?.(sessionState.transcript);
      else sessionState.rejectFinal?.(new Error(nativeSpeechExitMessage(sessionState, code, signal)));
    }
  });

  const timeout = setTimeout(() => {
    sessionState.rejectReady?.(new Error("macOS 系统转写启动超时。请检查麦克风和语音识别权限。"));
  }, JUST_NOW_START_TIMEOUT_MS);
  try {
    const ready = await sessionState.readyPromise;
    clearTimeout(timeout);
    appendActivity({
      type: "just_now.record_start",
      title: "开始记录刚刚发生了啥",
      source: APP_NAME,
      meta: {
        transcriptionSource: "macos-speech",
        inputDevice: ready.inputDevice || ""
      }
    });
    return ready;
  } catch (error) {
    clearTimeout(timeout);
    if (!child.killed) child.kill("SIGTERM");
    if (nativeJustNowSession === sessionState) nativeJustNowSession = null;
    appendJustNowError("record_start", error, {
      helperPath,
      debugDir,
      exitCode: sessionState.exitCode ?? "",
      exitSignal: sessionState.exitSignal || "",
      stderr: sessionState.stderr.slice(0, 1000)
    });
    throw error;
  }
}

async function stopNativeJustNowRecording() {
  const sessionState = nativeJustNowSession;
  if (!sessionState) throw new Error("当前没有正在记录的“刚刚发生了啥”。");
  if (!sessionState.child.killed) {
    try {
      sessionState.child.stdin.write("\n");
      sessionState.child.stdin.end();
    } catch (error) {
      sessionState.error = justNowErrorMessage(error, "无法结束 macOS 系统转写。");
    }
  }
  const killTimer = setTimeout(() => {
    if (!sessionState.child.killed) sessionState.child.kill("SIGTERM");
  }, JUST_NOW_STOP_TIMEOUT_MS);
  try {
    const transcript = String(await sessionState.finalPromise || "").trim();
    clearTimeout(killTimer);
    nativeJustNowSession = null;
    if (!transcript) {
      const recordingBytes = Number(sessionState.diagnostics?.recordingBytes || 0);
      const recognitionError = String(sessionState.diagnostics?.recognitionError || "").trim();
      const inputDevice = String(sessionState.diagnostics?.inputDevice || "").trim();
      if (recordingBytes > 0) {
        const suffix = recognitionError ? `系统返回：${recognitionError}` : "系统没有返回可识别文字。";
        throw new Error(`已录到本机音频，但 macOS Speech 没识别出文字。输入设备：${inputDevice || "未知"}。${suffix}`);
      }
      throw new Error("没有收到麦克风音频。请检查系统设置里的麦克风权限和当前输入设备。");
    }
    const durationMs = Date.now() - sessionState.startedAt;
    appendActivity({
      type: "just_now.record_stop",
      title: "刚刚发生了啥转写完成",
      source: APP_NAME,
      detail: transcript.slice(0, 260),
      meta: {
        durationMs,
        transcriptionSource: "macos-speech",
        inputDevice: sessionState.diagnostics?.inputDevice || "",
        recordingBytes: Number(sessionState.diagnostics?.recordingBytes || 0),
        peakPower: Number(sessionState.diagnostics?.peakPower || -160),
        averagePower: Number(sessionState.diagnostics?.averagePower || -160)
      }
    });
    const saved = saveJustNowDraft({
      transcript,
      durationMs,
      transcriptionSource: "macos-speech"
    });
    appendActivity({
      type: "just_now.transcript",
      title: "刚刚发生了啥转写草稿",
      source: APP_NAME,
      detail: transcript.slice(0, 260),
      meta: {
        historyId: saved.id,
        durationMs,
        transcriptionSource: "macos-speech",
        status: saved.status
      }
    });
    return saved;
  } catch (error) {
    clearTimeout(killTimer);
    nativeJustNowSession = null;
    appendJustNowError("record_stop", error, {
      exitCode: sessionState.exitCode ?? "",
      exitSignal: sessionState.exitSignal || "",
      durationMs: Date.now() - sessionState.startedAt,
      stderr: sessionState.stderr.slice(0, 1000),
      debugDir: justNowDebugDir(),
      diagnostics: sessionState.diagnostics || {}
    });
    throw error;
  }
}

async function summarizeJustNow(input = {}) {
  const template = readJustNowTemplate();
  const existingId = String(input.id || "").trim();
  const existing = existingId ? getJustNowEntry(existingId) : null;
  const manualTranscript = String(input.transcript || "").trim();
  const transcript = manualTranscript || String(existing?.editedTranscript || existing?.transcript || "").trim();
  const transcriptionWarning = String(input.transcriptionWarning || "").trim();
  const transcriptionSource = String(input.transcriptionSource || existing?.transcriptionSource || "manual").trim();
  if (!transcript) {
    throw new Error("没有可总结的转写文字。");
  }

  const durationMs = Math.max(0, Number.parseInt(String(input.durationMs || existing?.durationMs || 0), 10) || 0);
  const ai = normalizeAiSettings(settings.ai);
  const fallbackSummary = [
    "刚刚发生了啥：已记录转写内容。",
    "",
    transcript
  ].join("\n");
  let result = {
    id: existing?.id || undefined,
    title: existing?.title || "刚刚发生了啥",
    transcript: existing?.transcript || transcript,
    editedTranscript: transcript,
    summary: fallbackSummary,
    html: textSummaryToHtml(fallbackSummary, transcriptionWarning || "LLM 未启用或未保存 API Key，当前只保存转写内容。"),
    template,
    durationMs,
    transcriptionSource,
    status: "summarized",
    fromModel: false,
    warning: transcriptionWarning || (!ai.enabled || !readAiApiKey() ? "LLM 未启用或未保存 API Key。" : ""),
    createdAt: existing?.createdAt,
    updatedAt: new Date().toISOString(),
    summarizedAt: new Date().toISOString()
  };

  if (ai.enabled && readAiApiKey()) {
    const summary = await callAiChat([
      {
        role: "system",
        content: [
          "你是 AI小力的即时会议/现场记录整理助手。",
          "只根据用户提供的转写内容总结，不要编造未出现的事实。",
          "用户会提供一个 Markdown 模板，它是本次整理的前置需求模板；在不违背真实性和安全限制的前提下优先遵循。",
          "用户可能已经二次编辑过转写文字；以用户确认后的转写内容为准。",
          "输出中文 HTML 片段，不要输出 Markdown，不要输出完整 html/body/head。",
          "只允许使用这些标签：article、section、h3、p、ul、li、strong、span。",
          "最外层使用 <article class=\"review-card\">。",
          "如果转写不清晰或数据不足，要明确说明缺口。不要使用 script、style、iframe、图片、链接或事件属性。"
        ].join("\n")
      },
      {
        role: "user",
        content: `请根据“刚刚发生了啥”的语音转写生成 HTML 复盘卡片。\n\n模板 Markdown：\n${template}\n\n转写内容：\n${transcript}`
      }
    ]);
    result = {
      ...result,
      summary,
      html: normalizeSummaryHtml(summary),
      fromModel: true,
      warning: transcriptionWarning
    };
  }

  const saved = saveJustNowEntry(result);
  appendActivity({
    type: "just_now.summary",
    title: "刚刚发生了啥",
    source: result.fromModel ? settings.ai.model : APP_NAME,
    detail: transcript.slice(0, 260),
    meta: {
      historyId: saved.id,
      durationMs,
      transcriptionSource,
      fromModel: result.fromModel,
      transcriptionWarning
    }
  });
  return saved;
}

function trimActivityLogIfNeeded() {
  const nowMs = Date.now();
  if (nowMs - lastActivityTrimAt < 60 * 60 * 1000) return;
  lastActivityTrimAt = nowMs;
  const filePath = activityLogPath();
  try {
    if (!fs.existsSync(filePath)) return;
    const retentionMs = normalizedRetentionDays(settings.ai?.retentionDays) * 24 * 60 * 60 * 1000;
    const keepAfter = nowMs - retentionMs;
    const kept = [];
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const tsMs = new Date(event.ts).getTime();
        if (Number.isFinite(tsMs) && tsMs >= keepAfter) kept.push(line);
      } catch {}
    }
    fs.writeFileSync(filePath, kept.length ? `${kept.join("\n")}\n` : "", "utf8");
  } catch {}
}

function appendActivity(event = {}) {
  const nowIso = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    ts: nowIso,
    ...event,
    type: String(event.type || "activity").trim() || "activity",
    title: String(event.title || "").trim(),
    source: String(event.source || "").trim()
  };
  fs.mkdirSync(path.dirname(activityLogPath()), { recursive: true });
  fs.appendFileSync(activityLogPath(), `${JSON.stringify(record)}\n`, "utf8");
  trimActivityLogIfNeeded();
  return record;
}

function loadState() {
  const storedReminders = readJson("reminders.json", []);
  settings = {
    ...defaultSettings,
    ...readJson("settings.json", {})
  };
  settings.ai = normalizeAiSettings(settings.ai);
  reminders = Array.isArray(storedReminders)
    ? storedReminders.map(normalizeStoredReminder).filter(Boolean)
    : [];
  try {
    settings.autoLaunch = app.getLoginItemSettings().openAtLogin;
  } catch {
    settings.autoLaunch = Boolean(settings.autoLaunch);
  }
  settings.mascotScale = normalizedScale(settings.mascotScale);
  settings.notificationBarPinned = Boolean(settings.notificationBarPinned);
}

function normalizeAiSettings(value = {}) {
  return {
    ...defaultSettings.ai,
    ...(value && typeof value === "object" ? value : {}),
    enabled: Boolean(value?.enabled),
    activityTracking: Boolean(value?.activityTracking),
    retentionDays: normalizedRetentionDays(value?.retentionDays),
    baseUrl: normalizeBaseUrl(value?.baseUrl || defaultSettings.ai.baseUrl),
    chatPath: normalizeChatPath(value?.chatPath || defaultSettings.ai.chatPath),
    model: String(value?.model || defaultSettings.ai.model).trim() || defaultSettings.ai.model,
    updatedAt: value?.updatedAt || ""
  };
}

function normalizedRetentionDays(value) {
  const days = Number.parseInt(String(value), 10);
  if (!Number.isFinite(days)) return 30;
  return Math.min(Math.max(days, 1), 180);
}

function normalizeBaseUrl(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  try {
    return new URL(raw).toString().replace(/\/+$/, "");
  } catch {
    return raw;
  }
}

function normalizeChatPath(value) {
  const raw = String(value || "/v1/chat/completions").trim() || "/v1/chat/completions";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function saveSettings() {
  settings.updatedAt = new Date().toISOString();
  writeJson("settings.json", settings);
}

function saveReminders() {
  writeJson("reminders.json", reminders);
}

function normalizeStoredReminder(reminder) {
  if (!reminder || typeof reminder !== "object") return null;
  const due = new Date(reminder.dueAt);
  if (!Number.isFinite(due.getTime())) return null;
  const nowIso = new Date().toISOString();
  const lastFiredAtDate = reminder.lastFiredAt ? new Date(reminder.lastFiredAt) : null;
  const lastSnoozedAtDate = reminder.lastSnoozedAt ? new Date(reminder.lastSnoozedAt) : null;
  const snoozeReturnDueAtDate = reminder.snoozeReturnDueAt ? new Date(reminder.snoozeReturnDueAt) : null;
  return {
    id: String(reminder.id || crypto.randomUUID()),
    title: String(reminder.title || "提醒").trim() || "提醒",
    body: String(reminder.body || "").trim(),
    dueAt: due.toISOString(),
    repeat: VALID_REPEATS.has(reminder.repeat) ? reminder.repeat : "none",
    enabled: reminder.enabled !== false,
    sourceLabel: String(reminder.sourceLabel || "").trim(),
    snoozeCount: Math.max(0, Number.parseInt(String(reminder.snoozeCount || 0), 10) || 0),
    snoozedFrom: String(reminder.snoozedFrom || "").trim(),
    lastSnoozedAt: lastSnoozedAtDate && Number.isFinite(lastSnoozedAtDate.getTime())
      ? lastSnoozedAtDate.toISOString()
      : "",
    snoozeReturnDueAt: snoozeReturnDueAtDate && Number.isFinite(snoozeReturnDueAtDate.getTime())
      ? snoozeReturnDueAtDate.toISOString()
      : "",
    lastFiredAt: lastFiredAtDate && Number.isFinite(lastFiredAtDate.getTime())
      ? lastFiredAtDate.toISOString()
      : "",
    createdAt: reminder.createdAt || nowIso,
    updatedAt: reminder.updatedAt || nowIso
  };
}

function normalizeReminderInput(input, current = {}) {
  const nowIso = new Date().toISOString();
  const due = new Date(input?.dueAt ?? current.dueAt);
  if (!Number.isFinite(due.getTime())) {
    throw new Error("提醒时间无效。");
  }
  const repeat = input?.repeat ?? current.repeat ?? "none";
  if (!VALID_REPEATS.has(repeat)) {
    throw new Error("重复频率无效。");
  }
  const title = String(input?.title ?? current.title ?? "").trim();
  if (!title) {
    throw new Error("提醒标题不能为空。");
  }
  const enabled = input?.enabled === undefined ? current.enabled !== false : Boolean(input.enabled);
  const normalizedDueAt = normalizeDueAtForSave(due, repeat, enabled);
  return {
    id: current.id || crypto.randomUUID(),
    title,
    body: String(input?.body ?? current.body ?? "").trim(),
    dueAt: normalizedDueAt,
    repeat,
    enabled,
    sourceLabel: String(input?.sourceLabel ?? current.sourceLabel ?? "").trim(),
    snoozeCount: Math.max(0, Number.parseInt(String(current.snoozeCount || 0), 10) || 0),
    snoozedFrom: String(current.snoozedFrom || "").trim(),
    lastSnoozedAt: current.lastSnoozedAt || "",
    snoozeReturnDueAt: current.snoozeReturnDueAt || "",
    lastFiredAt: current.lastFiredAt || "",
    createdAt: current.createdAt || nowIso,
    updatedAt: nowIso
  };
}

function normalizeDueAtForSave(due, repeat, enabled = true) {
  if (!enabled) return due.toISOString();
  const nowMs = Date.now();
  if (repeat === "none") {
    if (due.getTime() <= nowMs + FUTURE_DUE_GRACE_MS) {
      throw new Error("一次性提醒需要选择未来时间。");
    }
    return due.toISOString();
  }

  const next = nextDueAt(due.toISOString(), repeat, nowMs + FUTURE_DUE_GRACE_MS);
  if (!next) throw new Error("无法计算下一次提醒时间。");
  return next;
}

function sortedReminders() {
  return [...reminders].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime();
  });
}

function normalizedSnoozeMinutes(value) {
  const minutes = Number.parseInt(String(value), 10);
  if (!Number.isFinite(minutes)) return DEFAULT_SNOOZE_MINUTES;
  return Math.min(Math.max(minutes, 5), 120);
}

function snoozeReminder(id, minutes = DEFAULT_SNOOZE_MINUTES) {
  const targetId = String(id || "");
  const duration = normalizedSnoozeMinutes(minutes);
  const nowIso = new Date().toISOString();
  const dueAt = new Date(Date.now() + duration * 60 * 1000).toISOString();
  const index = reminders.findIndex((item) => item.id === targetId);

  if (index < 0) throw new Error("找不到要稍后提醒的事项。");
  const original = reminders[index];
  const snoozed = {
    ...original,
    dueAt,
    enabled: true,
    snoozeCount: (original.snoozeCount || 0) + 1,
    lastSnoozedAt: nowIso,
    snoozeReturnDueAt: original.repeat === "none" ? "" : (original.snoozeReturnDueAt || original.dueAt),
    updatedAt: nowIso
  };
  reminders[index] = snoozed;
  activeReminderPayload = null;
  saveReminders();
  broadcastReminders();
  appendActivity({
    type: "reminder.snooze",
    title: snoozed.title,
    source: snoozed.sourceLabel || "提醒",
    detail: `${duration} 分钟后再次提醒`,
    meta: {
      reminderId: snoozed.id,
      snoozedFrom: snoozed.snoozedFrom,
      previousDueAt: original.dueAt,
      dueAt,
      repeat: snoozed.repeat,
      snoozeCount: snoozed.snoozeCount,
      snoozeReturnDueAt: snoozed.snoozeReturnDueAt,
      minutes: duration
    }
  });
  return snoozed;
}

function broadcast(channel, payload) {
  for (const win of [mascotWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

function broadcastSettings() {
  broadcast("settings:changed", publicSettings());
  updateTrayMenu();
  updateApplicationMenu();
  sendMascotState();
}

function broadcastReminders() {
  broadcast("reminders:changed", sortedReminders());
}

function publicSettings() {
  let autoLaunch = settings.autoLaunch;
  try {
    autoLaunch = app.getLoginItemSettings().openAtLogin;
  } catch {
    autoLaunch = Boolean(autoLaunch);
  }
  return {
    ...settings,
    mascotScale: normalizedScale(settings.mascotScale),
    notificationBarPinned: Boolean(settings.notificationBarPinned),
    autoLaunch
  };
}

function publicAiConfig() {
  return {
    ...normalizeAiSettings(settings.ai),
    hasApiKey: Boolean(readAiApiKey()),
    keyStorage: safeStorage.isEncryptionAvailable() ? "safeStorage" : "plain"
  };
}

function updateAiConfig(input = {}) {
  const nextAi = normalizeAiSettings({
    ...settings.ai,
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : settings.ai?.enabled,
    activityTracking: input.activityTracking !== undefined
      ? Boolean(input.activityTracking)
      : settings.ai?.activityTracking,
    retentionDays: input.retentionDays !== undefined ? input.retentionDays : settings.ai?.retentionDays,
    baseUrl: input.baseUrl !== undefined ? input.baseUrl : settings.ai?.baseUrl,
    chatPath: input.chatPath !== undefined ? input.chatPath : settings.ai?.chatPath,
    model: input.model !== undefined ? input.model : settings.ai?.model,
    updatedAt: new Date().toISOString()
  });
  if (input.apiKey !== undefined) {
    writeAiApiKey(input.apiKey);
  }
  const trackingChanged = Boolean(settings.ai?.activityTracking) !== Boolean(nextAi.activityTracking);
  settings.ai = nextAi;
  saveSettings();
  if (trackingChanged) {
    appendActivity({
      type: "activity.tracking",
      title: nextAi.activityTracking ? "开启活动统计" : "关闭活动统计",
      source: APP_NAME
    });
    restartActivityTracking();
  }
  return publicAiConfig();
}

function normalizedScale(value) {
  const scale = Number.parseFloat(String(value));
  if (!Number.isFinite(scale)) return 1;
  return Math.min(Math.max(scale, MIN_MASCOT_SCALE), MAX_MASCOT_SCALE);
}

function mascotSizeForScale(scale = settings.mascotScale) {
  const normalized = normalizedScale(scale);
  return {
    width: Math.round(MASCOT_SIZE.width * normalized),
    height: Math.round(MASCOT_SIZE.height * normalized)
  };
}

function defaultMascotBounds() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const size = mascotSizeForScale();
  return {
    x: Math.round(area.x + area.width - size.width - 32),
    y: Math.round(area.y + area.height - size.height - 48),
    width: size.width,
    height: size.height
  };
}

function normalizedBounds(bounds) {
  const fallback = defaultMascotBounds();
  if (!bounds || typeof bounds !== "object") return fallback;
  const size = mascotSizeForScale();
  const display = screen.getDisplayMatching({
    x: Number.isFinite(bounds.x) ? bounds.x : fallback.x,
    y: Number.isFinite(bounds.y) ? bounds.y : fallback.y,
    width: Number.isFinite(bounds.width) ? bounds.width : size.width,
    height: Number.isFinite(bounds.height) ? bounds.height : size.height
  });
  const area = display.workArea;
  const previousRight = Number.isFinite(bounds.width) ? bounds.x + bounds.width : fallback.x + fallback.width;
  const previousBottom = Number.isFinite(bounds.height) ? bounds.y + bounds.height : fallback.y + fallback.height;
  const rawX = Number.isFinite(previousRight) ? previousRight - size.width : fallback.x;
  const rawY = Number.isFinite(previousBottom) ? previousBottom - size.height : fallback.y;
  const x = Math.min(Math.max(Math.round(rawX), area.x), area.x + area.width - size.width);
  const y = Math.min(Math.max(Math.round(rawY), area.y), area.y + area.height - size.height);
  return {
    x,
    y,
    ...size
  };
}

function resizeMascotWindowForScale(nextScale, preserveBottomRight = true) {
  if (!mascotWindow || mascotWindow.isDestroyed()) return;
  const size = mascotSizeForScale(nextScale);
  const current = mascotWindow.getBounds();
  const nextBounds = preserveBottomRight
    ? {
        x: current.x + current.width - size.width,
        y: current.y + current.height - size.height,
        ...size
      }
    : {
        x: current.x,
        y: current.y,
        ...size
      };
  mascotWindow.setBounds(nextBounds);
  settings.mascotBounds = nextBounds;
}

function setMascotMousePassthrough(ignore) {
  if (!mascotWindow || mascotWindow.isDestroyed()) return;
  const next = Boolean(ignore);
  if (mascotDragState && next) return;
  if (mousePassthroughEnabled === next) return;
  mousePassthroughEnabled = next;
  mascotWindow.setIgnoreMouseEvents(next, { forward: true });
}

function pointInRect(point, rect) {
  return point.x >= rect.x
    && point.x <= rect.x + rect.width
    && point.y >= rect.y
    && point.y <= rect.y + rect.height;
}

function mascotInteractiveRegion() {
  if (!mascotWindow || mascotWindow.isDestroyed()) return [];
  const bounds = mascotWindow.getBounds();
  const scale = normalizedScale(settings.mascotScale);
  const regions = [];
  if (mascotBubbleInteractive) {
    regions.push({
      x: 0,
      y: 0,
      width: Math.min(bounds.width, 220),
      height: Math.min(bounds.height, 120)
    });
  }
  const bodyWidth = Math.min(bounds.width * 0.88, 276 * scale * 1.42);
  const bodyHeight = Math.min(bounds.height * 0.78, 365 * scale * 1.42);
  const bodyBottom = bounds.height - Math.max(8, 8 * scale);
  const bodyLeft = (bounds.width - bodyWidth) / 2;
  const bodyTop = Math.max(0, bodyBottom - bodyHeight);
  const actionSize = 132 * scale;
  const actionLeft = (bounds.width / 2) + (82 * scale);
  const actionTop = bodyTop + (54 * scale);
  regions.push(
    { x: bodyLeft, y: bodyTop, width: bodyWidth, height: bodyHeight },
    { x: actionLeft - 12, y: actionTop - 12, width: actionSize, height: actionSize }
  );
  return regions;
}

function updateMascotMousePassthroughFromCursor() {
  if (!mascotWindow || mascotWindow.isDestroyed() || !mascotWindow.isVisible()) return;
  if (mascotDragState) {
    setMascotMousePassthrough(false);
    return;
  }
  const bounds = mascotWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  if (!pointInRect(cursor, bounds)) {
    setMascotMousePassthrough(true);
    return;
  }
  const localPoint = {
    x: cursor.x - bounds.x,
    y: cursor.y - bounds.y
  };
  const overInteractiveRegion = mascotInteractiveRegion().some((rect) => pointInRect(localPoint, rect));
  setMascotMousePassthrough(!overInteractiveRegion);
}

function startMascotMousePoll() {
  clearInterval(mousePollTimer);
  mousePollTimer = setInterval(updateMascotMousePassthroughFromCursor, MASCOT_INTERACTION_POLL_MS);
}

function stopMascotMousePoll() {
  clearInterval(mousePollTimer);
  mousePollTimer = null;
}

function readForegroundApp() {
  const script = [
    'tell application "System Events"',
    '  set frontApp to first application process whose frontmost is true',
    '  set appName to name of frontApp',
    '  set winTitle to ""',
    '  try',
    '    set winTitle to name of front window of frontApp',
    '  end try',
    '  return appName & "\\n" & winTitle',
    'end tell'
  ].join("\n");
  return new Promise((resolve, reject) => {
    execFile("/usr/bin/osascript", ["-e", script], { timeout: 5000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      const [appName = "", ...titleParts] = String(stdout || "").trim().split(/\r?\n/);
      resolve({
        appName: appName.trim() || "未知应用",
        windowTitle: titleParts.join(" ").trim()
      });
    });
  });
}

function foregroundKey(entry) {
  return `${entry.appName || ""}\n${entry.windowTitle || ""}`;
}

function flushForegroundSegment(endedAt = new Date()) {
  if (!currentForeground) return;
  const endMs = endedAt.getTime();
  const startMs = new Date(currentForeground.startedAt).getTime();
  const durationMs = Math.max(0, endMs - startMs);
  if (durationMs >= 5000) {
    appendActivity({
      type: "app.active",
      title: currentForeground.windowTitle || currentForeground.appName,
      source: currentForeground.appName,
      startedAt: currentForeground.startedAt,
      endedAt: endedAt.toISOString(),
      durationMs,
      meta: {
        appName: currentForeground.appName,
        windowTitle: currentForeground.windowTitle
      }
    });
  }
}

async function pollForegroundActivity() {
  if (!settings.ai?.activityTracking) return;
  try {
    const observed = await readForegroundApp();
    const now = new Date();
    if (!currentForeground) {
      currentForeground = {
        ...observed,
        startedAt: now.toISOString(),
        lastSeenAt: now.toISOString()
      };
      return;
    }
    if (foregroundKey(currentForeground) !== foregroundKey(observed)) {
      flushForegroundSegment(now);
      currentForeground = {
        ...observed,
        startedAt: now.toISOString(),
        lastSeenAt: now.toISOString()
      };
    } else {
      currentForeground.lastSeenAt = now.toISOString();
    }
  } catch (error) {
    const nowMs = Date.now();
    if (nowMs - lastForegroundErrorAt > 10 * 60 * 1000) {
      lastForegroundErrorAt = nowMs;
      appendActivity({
        type: "activity.tracking_error",
        title: "前台窗口读取失败",
        source: "macOS",
        detail: "需要在系统设置里允许 AI小力 使用辅助功能权限后，才能统计前台 App/窗口标题。",
        meta: { message: error?.message || String(error) }
      });
    }
  }
}

function startActivityTracking() {
  clearInterval(activityTimer);
  if (!settings.ai?.activityTracking) return;
  pollForegroundActivity();
  activityTimer = setInterval(pollForegroundActivity, ACTIVITY_POLL_MS);
}

function stopActivityTracking() {
  clearInterval(activityTimer);
  activityTimer = null;
  flushForegroundSegment(new Date());
  currentForeground = null;
}

function restartActivityTracking() {
  stopActivityTracking();
  startActivityTracking();
}

function installPermissionHandlers() {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const isOwnWindow = [mascotWindow?.webContents, settingsWindow?.webContents].includes(webContents);
    if (isOwnWindow && permission === "media" && details.mediaTypes?.includes("audio")) {
      callback(true);
      return;
    }
    callback(false);
  });
}

function createMascotWindow() {
  if (mascotWindow && !mascotWindow.isDestroyed()) return mascotWindow;
  mascotWindow = new BrowserWindow({
    ...normalizedBounds(settings.mascotBounds),
    show: false,
    transparent: true,
    frame: false,
    resizable: false,
    movable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    title: APP_NAME,
    icon: APP_LOGO_PATH,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mascotWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mascotWindow.setAlwaysOnTop(true, "screen-saver");
  mascotWindow.loadFile(path.join(__dirname, "renderer", "mascot.html"));

  mascotWindow.once("ready-to-show", () => {
    setMascotMousePassthrough(true);
    startMascotMousePoll();
    if (settings.mascotVisible) mascotWindow.show();
  });

  mascotWindow.on("move", () => {
    clearTimeout(saveBoundsTimer);
    saveBoundsTimer = setTimeout(() => {
      if (!mascotWindow || mascotWindow.isDestroyed()) return;
      settings.mascotBounds = mascotWindow.getBounds();
      saveSettings();
    }, 300);
  });

  mascotWindow.on("closed", () => {
    stopMascotMousePoll();
    mousePassthroughEnabled = null;
    mascotDragState = null;
    mascotBubbleInteractive = false;
    mascotWindow = null;
  });

  return mascotWindow;
}

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.show();
    settingsWindow.focus();
    return settingsWindow;
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_SIZE.width,
    height: SETTINGS_SIZE.height,
    minWidth: 960,
    minHeight: 680,
    title: APP_NAME,
    icon: APP_LOGO_PATH,
    autoHideMenuBar: true,
    backgroundColor: "#f7f4ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  return settingsWindow;
}

function showSettingsAndFocusForm() {
  const win = createSettingsWindow();
  const sendFocus = () => {
    if (win && !win.isDestroyed()) win.webContents.send("settings:focusCreate");
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", sendFocus);
  } else {
    sendFocus();
  }
}

function showSettingsAndFocusAi() {
  const win = createSettingsWindow();
  const sendFocus = () => {
    if (win && !win.isDestroyed()) win.webContents.send("settings:focusAi");
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", sendFocus);
  } else {
    sendFocus();
  }
}

function showSettingsAndFocusJustNow(historyId = "") {
  const win = createSettingsWindow();
  const sendFocus = () => {
    if (win && !win.isDestroyed()) win.webContents.send("settings:focusJustNow", { historyId });
  };
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", sendFocus);
  } else {
    sendFocus();
  }
}

function trayImage() {
  if (fs.existsSync(APP_LOGO_PATH)) {
    return nativeImage.createFromPath(APP_LOGO_PATH);
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="18" fill="#121018"/>
      <circle cx="32" cy="33" r="20" fill="#fff4dc"/>
      <path d="M14 29c4-15 32-15 36 0" fill="#fff8eb"/>
      <rect x="13" y="20" width="38" height="16" rx="6" fill="#ff8a1f"/>
      <path d="M22 48h20l8 10H14z" fill="#2a2256"/>
      <circle cx="25" cy="36" r="3" fill="#7a241b"/>
      <circle cx="39" cy="36" r="3" fill="#7a241b"/>
      <path d="M28 43c3 3 5 3 8 0" fill="none" stroke="#d34c33" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `;
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
}

function createTray() {
  tray = new Tray(trayImage().resize({ width: 18, height: 18 }));
  if (process.platform === "darwin") tray.setTitle("小力");
  tray.setToolTip(`${APP_NAME} · ${APP_SUBTITLE}`);
  tray.on("click", () => createSettingsWindow());
  updateTrayMenu();
}

function updateApplicationMenu() {
  const visible = Boolean(settings.mascotVisible);
  const paused = Boolean(settings.paused);
  const pinned = Boolean(settings.notificationBarPinned);
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { label: `关于${APP_NAME}`, role: "about" },
        { type: "separator" },
        { label: "隐藏", role: "hide" },
        { label: "隐藏其他", role: "hideOthers" },
        { label: "显示全部", role: "unhide" },
        { type: "separator" },
        { label: "退出", role: "quit" }
      ]
    },
    {
      label: "小力",
      submenu: [
        { label: "添加提醒", click: showSettingsAndFocusForm },
        { label: "查看提醒", click: createSettingsWindow },
        { label: "AI 总结", click: showSettingsAndFocusAi },
        { label: "刚刚发生了啥", click: () => showSettingsAndFocusJustNow() },
        { type: "separator" },
        {
          label: "显示小力",
          type: "checkbox",
          checked: visible,
          click: (menuItem) => updateSettings({ mascotVisible: menuItem.checked })
        },
        {
          label: "顶部通知栏常驻",
          type: "checkbox",
          checked: pinned,
          click: (menuItem) => updateSettings({ notificationBarPinned: menuItem.checked })
        },
        {
          label: paused ? "恢复提醒" : "暂停提醒",
          click: () => updateSettings({ paused: !paused })
        },
        { type: "separator" },
        {
          label: "小力大小",
          submenu: [
            { label: "小", type: "radio", checked: settings.mascotScale <= 0.85, click: () => updateSettings({ mascotScale: 0.8 }) },
            { label: "标准", type: "radio", checked: settings.mascotScale > 0.85 && settings.mascotScale < 1.15, click: () => updateSettings({ mascotScale: 1 }) },
            { label: "大", type: "radio", checked: settings.mascotScale >= 1.15, click: () => updateSettings({ mascotScale: 1.25 }) }
          ]
        }
      ]
    },
    { label: "编辑", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "窗口", submenu: [{ role: "minimize" }, { role: "close" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function updateTrayMenu() {
  if (!tray) return;
  const visible = Boolean(settings.mascotVisible);
  const paused = Boolean(settings.paused);
  const pinned = Boolean(settings.notificationBarPinned);
  const autoLaunch = publicSettings().autoLaunch;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "添加提醒", click: showSettingsAndFocusForm },
    { label: "查看提醒", click: createSettingsWindow },
    { label: "AI 总结", click: showSettingsAndFocusAi },
    { label: "刚刚发生了啥", click: () => showSettingsAndFocusJustNow() },
    { type: "separator" },
    {
      label: paused ? "恢复提醒" : "暂停提醒",
      click: () => updateSettings({ paused: !paused })
    },
    {
      label: visible ? "隐藏小力" : "显示小力",
      click: () => updateSettings({ mascotVisible: !visible })
    },
    {
      label: "顶部通知栏常驻",
      type: "checkbox",
      checked: pinned,
      click: (menuItem) => updateSettings({ notificationBarPinned: menuItem.checked })
    },
    {
      label: "开机启动",
      type: "checkbox",
      checked: autoLaunch,
      click: (menuItem) => updateSettings({ autoLaunch: menuItem.checked })
    },
    { type: "separator" },
    {
      label: "退出",
      role: "quit"
    }
  ]));
}

function updateSettings(patch = {}) {
  if (Object.prototype.hasOwnProperty.call(patch, "autoLaunch")) {
    const openAtLogin = Boolean(patch.autoLaunch);
    try {
      app.setLoginItemSettings({ openAtLogin });
      settings.autoLaunch = app.getLoginItemSettings().openAtLogin;
    } catch {
      settings.autoLaunch = openAtLogin;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "paused")) {
    settings.paused = Boolean(patch.paused);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "notificationBarPinned")) {
    settings.notificationBarPinned = Boolean(patch.notificationBarPinned);
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mascotScale")) {
    const nextScale = normalizedScale(patch.mascotScale);
    if (nextScale !== settings.mascotScale) {
      settings.mascotScale = nextScale;
      resizeMascotWindowForScale(nextScale);
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "mascotVisible")) {
    settings.mascotVisible = Boolean(patch.mascotVisible);
    if (mascotWindow && !mascotWindow.isDestroyed()) {
      if (settings.mascotVisible) mascotWindow.show();
      else mascotWindow.hide();
    }
  }
  if (patch.mascotBounds && typeof patch.mascotBounds === "object") {
    settings.mascotBounds = normalizedBounds(patch.mascotBounds);
  }
  saveSettings();
  broadcastSettings();
  return publicSettings();
}

function sendMascotState() {
  if (mascotWindow && !mascotWindow.isDestroyed()) {
    mascotWindow.webContents.send("mascot:state", {
      paused: settings.paused,
      visible: settings.mascotVisible,
      mascotScale: normalizedScale(settings.mascotScale),
      notificationBarPinned: Boolean(settings.notificationBarPinned)
    });
  }
}

function nextDueAt(currentDueAt, repeat, nowMs) {
  if (repeat === "none") return "";
  const next = new Date(currentDueAt);
  if (!Number.isFinite(next.getTime())) return "";
  let guard = 0;
  while (next.getTime() <= nowMs && guard < 730) {
    if (repeat === "daily") next.setDate(next.getDate() + 1);
    if (repeat === "weekly") next.setDate(next.getDate() + 7);
    if (repeat === "monthly") next.setMonth(next.getMonth() + 1);
    guard += 1;
  }
  return next.toISOString();
}

function padTimePart(value) {
  return String(value).padStart(2, "0");
}

function localTimeZoneLabel() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "本机时区";
}

function formatLocalDateTime(value, { seconds = false } = {}) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const base = [
    date.getFullYear(),
    "-",
    padTimePart(date.getMonth() + 1),
    "-",
    padTimePart(date.getDate()),
    " ",
    padTimePart(date.getHours()),
    ":",
    padTimePart(date.getMinutes())
  ].join("");
  return seconds ? `${base}:${padTimePart(date.getSeconds())}` : base;
}

function activityRange(range = "today") {
  const now = new Date();
  const end = now;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (range === "yesterday") {
    start.setDate(start.getDate() - 1);
    const yesterdayEnd = new Date(start);
    yesterdayEnd.setHours(23, 59, 59, 999);
    return { start, end: yesterdayEnd, label: "昨天" };
  }
  if (range === "7d") {
    start.setDate(start.getDate() - 6);
    return { start, end, label: "最近7天" };
  }
  return { start, end, label: "今天" };
}

function parseLocalDateOnly(value, endOfDay = false) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  else date.setHours(0, 0, 0, 0);
  return date;
}

function formatDateLabel(date) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function resolveActivityRange(input = {}) {
  if (input.range === "custom") {
    const start = parseLocalDateOnly(input.startDate);
    const end = parseLocalDateOnly(input.endDate, true);
    if (!start || !end) throw new Error("请选择有效的自选起止日期。");
    if (end.getTime() < start.getTime()) throw new Error("结束日期不能早于开始日期。");
    return {
      start,
      end,
      label: `${formatDateLabel(start)} 至 ${formatDateLabel(end)}`
    };
  }
  return activityRange(input.range || "today");
}

function readActivityEvents({ start, end, limit = 600 } = {}) {
  const filePath = activityLogPath();
  const startMs = start ? start.getTime() : 0;
  const endMs = end ? end.getTime() : Date.now();
  const events = [];
  try {
    if (!fs.existsSync(filePath)) return events;
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        const tsMs = new Date(event.ts).getTime();
        if (!Number.isFinite(tsMs) || tsMs < startMs || tsMs > endMs) continue;
        events.push(event);
      } catch {}
    }
  } catch {}
  if (currentForeground && settings.ai?.activityTracking) {
    const now = new Date();
    const segmentStart = new Date(currentForeground.startedAt);
    const segmentEnd = now;
    if (segmentEnd.getTime() >= startMs && segmentStart.getTime() <= endMs) {
      events.push({
        id: "current-foreground",
        ts: segmentStart.toISOString(),
        type: "app.active",
        title: currentForeground.windowTitle || currentForeground.appName,
        source: currentForeground.appName,
        startedAt: segmentStart.toISOString(),
        endedAt: segmentEnd.toISOString(),
        durationMs: Math.max(0, segmentEnd.getTime() - segmentStart.getTime()),
        meta: {
          appName: currentForeground.appName,
          windowTitle: currentForeground.windowTitle
        }
      });
    }
  }
  return events
    .sort((left, right) => new Date(left.ts).getTime() - new Date(right.ts).getTime())
    .slice(-limit);
}

function summarizeActivityStats(events) {
  const appUsage = new Map();
  const counts = new Map();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) || 0) + 1);
    if (event.type === "app.active" && event.source && Number.isFinite(Number(event.durationMs))) {
      appUsage.set(event.source, (appUsage.get(event.source) || 0) + Number(event.durationMs));
    }
  }
  return {
    totalEvents: events.length,
    counts: Object.fromEntries([...counts.entries()].sort()),
    appUsage: [...appUsage.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 12)
      .map(([appName, durationMs]) => ({
        appName,
        minutes: Math.round(durationMs / 60000)
      }))
  };
}

function compactActivityEvent(event) {
  const eventLocalTime = formatLocalDateTime(event.ts, { seconds: true });
  const startedAtLocal = formatLocalDateTime(event.startedAt, { seconds: true });
  const endedAtLocal = formatLocalDateTime(event.endedAt, { seconds: true });
  return {
    time: eventLocalTime || event.ts,
    timeLocal: eventLocalTime || undefined,
    timeUtc: event.ts,
    type: event.type,
    title: String(event.title || "").slice(0, 120),
    source: String(event.source || "").slice(0, 80),
    startedAt: startedAtLocal || undefined,
    endedAt: endedAtLocal || undefined,
    startedAtUtc: event.startedAt,
    endedAtUtc: event.endedAt,
    durationMinutes: Number.isFinite(Number(event.durationMs))
      ? Math.round(Number(event.durationMs) / 60000)
      : undefined,
    detail: event.detail ? String(event.detail).slice(0, 260) : undefined,
    meta: event.meta
      ? {
          appName: String(event.meta.appName || "").slice(0, 80),
          windowTitle: String(event.meta.windowTitle || "").slice(0, 160),
          reminderId: String(event.meta.reminderId || "").slice(0, 80),
          previousDueAt: String(event.meta.previousDueAt || "").slice(0, 40),
          previousDueAtLocal: formatLocalDateTime(event.meta.previousDueAt, { seconds: true }) || undefined,
          dueAt: String(event.meta.dueAt || "").slice(0, 40),
          dueAtLocal: formatLocalDateTime(event.meta.dueAt, { seconds: true }) || undefined,
          repeat: String(event.meta.repeat || "").slice(0, 20),
          minutes: Number.isFinite(Number(event.meta.minutes)) ? Number(event.meta.minutes) : undefined,
          snoozeCount: Number.isFinite(Number(event.meta.snoozeCount)) ? Number(event.meta.snoozeCount) : undefined,
          snoozeReturnDueAt: String(event.meta.snoozeReturnDueAt || "").slice(0, 40),
          snoozeReturnDueAtLocal: formatLocalDateTime(event.meta.snoozeReturnDueAt, { seconds: true }) || undefined,
          historyId: String(event.meta.historyId || "").slice(0, 80)
        }
      : undefined
  };
}

function localActivitySummary({ label, events, stats }) {
  if (!events.length) {
    return `${label}还没有足够的本地活动记录。可以先开启“前台 App 活动统计”，或者继续使用提醒/聆听功能，之后小力就能汇总更多上下文。`;
  }
  const appLine = stats.appUsage.length
    ? `主要使用：${stats.appUsage.map((item) => `${item.appName} ${item.minutes}分钟`).join("、")}。`
    : "暂时没有前台 App 时长统计。";
  const reminderCount = (stats.counts["reminder.fire"] || 0) + (stats.counts["reminder.create"] || 0);
  const snoozeCount = stats.counts["reminder.snooze"] || 0;
  const latest = events.slice(-6).map((event) => {
    const time = new Date(event.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `- ${time} ${event.source || event.type}：${event.title || event.detail || event.type}`;
  }).join("\n");
  return [
    `${label}本地统计：共记录 ${stats.totalEvents} 条活动。${appLine}`,
    `提醒相关事件 ${reminderCount} 条，其中拖延/稍后提醒 ${snoozeCount} 条；聆听/桌宠交互 ${stats.counts["mascot.listen"] || 0} 条。`,
    "最近活动：",
    latest
  ].join("\n");
}

function textSummaryToHtml(text, warning = "") {
  const blocks = [];
  if (warning) {
    blocks.push(`<section><h3>提示</h3><p>${escapeHtmlForHtml(warning)}</p></section>`);
  }
  for (const part of String(text || "").split(/\n{2,}/).filter(Boolean)) {
    const lines = part.split(/\n/).filter(Boolean);
    const listItems = lines.filter((line) => line.trim().startsWith("- "));
    if (listItems.length === lines.length) {
      blocks.push(`<section><ul>${listItems.map((line) => `<li>${escapeHtmlForHtml(line.replace(/^-\s*/, ""))}</li>`).join("")}</ul></section>`);
    } else {
      blocks.push(`<section>${lines.map((line) => `<p>${escapeHtmlForHtml(line)}</p>`).join("")}</section>`);
    }
  }
  return `<article class="review-card">${blocks.join("")}</article>`;
}

function escapeHtmlForHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function normalizeSummaryHtml(value) {
  return String(value || "")
    .replace(/^```html\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function chatCompletionUrl(ai = settings.ai) {
  const base = normalizeBaseUrl(ai.baseUrl);
  if (!base) throw new Error("请先填写通用 LLM API Base URL。");
  return new URL(normalizeChatPath(ai.chatPath), `${base}/`).toString();
}

async function callAiChat(messages) {
  const ai = normalizeAiSettings(settings.ai);
  const apiKey = readAiApiKey();
  if (!apiKey) throw new Error("请先保存 LLM API Key。");
  if (!ai.model) throw new Error("请先填写模型名称。");
  const response = await fetch(chatCompletionUrl(ai), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: ai.model,
      messages,
      temperature: 0.2
    })
  });
  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `LLM 请求失败：HTTP ${response.status}`);
  }
  const content = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || "";
  if (!content) throw new Error("LLM 没有返回总结内容。");
  return String(content).trim();
}

async function testAiConnection() {
  const content = await callAiChat([
    { role: "system", content: "你是 AI小力的连接测试助手，只回复一句中文。不要展开。" },
    { role: "user", content: "请回复：小力已连接。" }
  ]);
  return { ok: true, message: content };
}

async function summarizeActivities(input = {}) {
  const { start, end, label } = resolveActivityRange(input);
  const reviewTemplate = resolveSummaryTemplate(input.templateId);
  const events = readActivityEvents({ start, end });
  const stats = summarizeActivityStats(events);
  const remindersSnapshot = sortedReminders().slice(0, 80).map((reminder) => ({
    title: reminder.title,
    body: reminder.body,
    dueAt: reminder.dueAt,
    dueAtLocal: formatLocalDateTime(reminder.dueAt, { seconds: true }),
    repeat: reminder.repeat,
    enabled: reminder.enabled,
    sourceLabel: reminder.sourceLabel,
    lastFiredAt: reminder.lastFiredAt,
    lastFiredAtLocal: formatLocalDateTime(reminder.lastFiredAt, { seconds: true })
  }));
  const localSummary = localActivitySummary({ label, events, stats });
  const payload = {
    range: {
      label,
      timeZone: localTimeZoneLabel(),
      startLocal: formatLocalDateTime(start, { seconds: true }),
      endLocal: formatLocalDateTime(end, { seconds: true }),
      start: start.toISOString(),
      end: end.toISOString()
    },
    timeRule: "time/timeLocal/startedAt/endedAt/dueAtLocal 均为用户本地时间；timeUtc/startUtc/endUtc/dueAt 为 UTC 原始值，仅用于审计。复盘时间线必须使用本地时间。",
    stats,
    reviewTemplate: {
      id: reviewTemplate.id,
      name: reviewTemplate.name,
      markdown: reviewTemplate.body
    },
    reminders: remindersSnapshot,
    events: events.slice(-320).map(compactActivityEvent),
    userRequest: String(input.prompt || "").trim()
  };
  const ai = normalizeAiSettings(settings.ai);
  if (!ai.enabled || !readAiApiKey()) {
    const warning = "LLM 未启用或未保存 API Key，当前返回本地统计摘要。";
    return persistSummaryResult({
      summary: localSummary,
      html: textSummaryToHtml(localSummary, warning),
      localSummary,
      stats,
      range: payload.range,
      template: {
        id: reviewTemplate.id,
        name: reviewTemplate.name
      },
      fromModel: false,
      warning
    }, input);
  }
  const summary = await callAiChat([
    {
      role: "system",
      content: [
        "你是 AI小力的私人活动总结助手。",
        "只根据用户提供的本地活动日志、提醒数据和前台 App 统计总结，不要编造未出现的事实。",
        "时间规则必须严格遵守：payload.range.timeZone 是用户本地时区；事件里的 time、timeLocal、startedAt、endedAt、dueAtLocal 是本地时间；timeUtc、startedAtUtc、endedAtUtc、dueAt 是 UTC 原始值。总结时间线一律使用本地时间，不要把 UTC 小时当成本地小时。",
        "如果活动日志里出现 reminder.snooze，要把它视为任务拖延/稍后提醒信号，可用于总结执行阻力和待跟进风险。",
        "用户会提供一个 Markdown 复盘模板，它是本次总结的前置需求模板；在不违背真实性和安全限制的前提下优先遵循。",
        "输出中文 HTML 片段，不要输出 Markdown，不要输出完整 html/body/head。",
        "只允许使用这些标签：article、section、h3、p、ul、li、strong、span。",
        "最外层使用 <article class=\"review-card\">。",
        "结构要适合在桌面应用内展示，包含：总体判断、时间线、主要成果、注意力分布、待跟进建议。",
        "如果数据不足，要明确说明缺口。不要使用 script、style、iframe、图片、链接或事件属性。"
      ].join("\n")
    },
    {
      role: "user",
      content: `请把这个时间范围内我做了什么整理成 HTML 复盘卡片。\n\n复盘模板 Markdown：\n${reviewTemplate.body}\n\n数据：\n${JSON.stringify(payload, null, 2)}`
    }
  ]);
  const html = normalizeSummaryHtml(summary);
  appendActivity({
    type: "ai.summary",
    title: `${label}活动总结`,
    source: settings.ai.model,
    detail: String(input.prompt || "").trim(),
    meta: {
      templateId: reviewTemplate.id,
      templateName: reviewTemplate.name
    }
  });
  return persistSummaryResult({
    summary,
    html,
    localSummary,
    stats,
    range: payload.range,
    template: {
      id: reviewTemplate.id,
      name: reviewTemplate.name
    },
    fromModel: true
  }, input);
}

function fireReminder(reminder) {
  const payload = {
    id: reminder.id,
    title: reminder.title,
    body: reminder.body,
    sourceLabel: reminder.sourceLabel,
    dueAt: reminder.dueAt
  };
  appendActivity({
    type: "reminder.fire",
    title: reminder.title,
    source: reminder.sourceLabel || "提醒",
    detail: reminder.body,
    meta: {
      dueAt: reminder.dueAt,
      repeat: reminder.repeat
    }
  });
  if (mascotWindow && !mascotWindow.isDestroyed()) {
    mascotWindow.show();
    mascotBubbleInteractive = true;
    activeReminderPayload = payload;
    updateMascotMousePassthroughFromCursor();
    mascotWindow.webContents.send("mascot:remind", payload);
  }
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: `AI小力：${reminder.title}`,
      body: reminder.body || reminder.sourceLabel || "时间到了。",
      silent: false
    });
    notification.on("click", () => {
      createSettingsWindow();
      if (mascotWindow && !mascotWindow.isDestroyed()) mascotWindow.show();
    });
    notification.show();
  }
}

function checkDueReminders() {
  if (checkingReminders || settings.paused) return;
  checkingReminders = true;
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let changed = false;
    for (const reminder of reminders) {
      if (!reminder.enabled) continue;
      const dueMs = new Date(reminder.dueAt).getTime();
      if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;
      fireReminder(reminder);
      reminder.lastFiredAt = nowIso;
      reminder.updatedAt = nowIso;
      if (reminder.repeat === "none") {
        reminder.enabled = false;
      } else {
        const returnDueMs = new Date(reminder.snoozeReturnDueAt || "").getTime();
        const baseDueAt = Number.isFinite(returnDueMs) ? reminder.snoozeReturnDueAt : reminder.dueAt;
        const next = Number.isFinite(returnDueMs) && returnDueMs > nowMs
          ? reminder.snoozeReturnDueAt
          : nextDueAt(baseDueAt, reminder.repeat, nowMs);
        if (next) reminder.dueAt = next;
        else reminder.enabled = false;
        reminder.snoozeReturnDueAt = "";
      }
      changed = true;
    }
    if (changed) {
      saveReminders();
      broadcastReminders();
    }
  } finally {
    checkingReminders = false;
  }
}

function startReminderLoop() {
  clearInterval(reminderTimer);
  reminderTimer = setInterval(checkDueReminders, REMINDER_POLL_MS);
  setTimeout(checkDueReminders, 2500);
}

function installIpcHandlers() {
  ipcMain.on("mascot:setMousePassthrough", (event, ignore) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    setMascotMousePassthrough(ignore);
  });
  ipcMain.on("mascot:setBubbleInteractive", (event, enabled) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    if (mascotBubbleInteractive && !enabled && activeReminderPayload) {
      appendActivity({
        type: "reminder.ack",
        title: activeReminderPayload.title,
        source: activeReminderPayload.sourceLabel || "提醒",
        detail: activeReminderPayload.body,
        meta: {
          reminderId: activeReminderPayload.id,
          dueAt: activeReminderPayload.dueAt
        }
      });
      activeReminderPayload = null;
    }
    mascotBubbleInteractive = Boolean(enabled);
    updateMascotMousePassthroughFromCursor();
  });
  ipcMain.on("activity:record", (event, payload = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    const type = String(payload.type || "");
    if (!["mascot.listen", "mascot.drag"].includes(type)) return;
    appendActivity({
      type,
      title: String(payload.title || "").slice(0, 120),
      source: APP_NAME,
      detail: String(payload.detail || "").slice(0, 260)
    });
  });
  ipcMain.on("mascot:dragStart", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    mascotDragState = {
      startPoint: { x, y },
      startBounds: mascotWindow.getBounds()
    };
    setMascotMousePassthrough(false);
  });
  ipcMain.on("mascot:dragMove", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents || !mascotDragState) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dx = Math.round(x - mascotDragState.startPoint.x);
    const dy = Math.round(y - mascotDragState.startPoint.y);
    const nextBounds = {
      ...mascotDragState.startBounds,
      x: mascotDragState.startBounds.x + dx,
      y: mascotDragState.startBounds.y + dy
    };
    mascotWindow.setBounds(nextBounds);
  });
  ipcMain.on("mascot:dragEnd", (event) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    mascotDragState = null;
    settings.mascotBounds = mascotWindow.getBounds();
    saveSettings();
    updateMascotMousePassthroughFromCursor();
  });

  ipcMain.handle("settings:get", () => publicSettings());
  ipcMain.handle("settings:update", (_event, patch) => updateSettings(patch || {}));
  ipcMain.handle("settings:open", () => {
    createSettingsWindow();
    return true;
  });
  ipcMain.handle("settings:openJustNow", (_event, input = {}) => {
    showSettingsAndFocusJustNow(input.historyId || "");
    return true;
  });
  ipcMain.handle("ai:getConfig", () => publicAiConfig());
  ipcMain.handle("ai:updateConfig", (_event, input) => updateAiConfig(input || {}));
  ipcMain.handle("ai:test", () => testAiConnection());
  ipcMain.handle("ai:summarize", (_event, input) => summarizeActivities(input || {}));
  ipcMain.handle("summaryTemplates:list", () => summaryTemplates());
  ipcMain.handle("summaryTemplates:save", (_event, input) => saveSummaryTemplate(input || {}));
  ipcMain.handle("summaryTemplates:delete", (_event, id) => deleteSummaryTemplate(id));
  ipcMain.handle("summaryHistory:list", () => publicSummaryHistory());
  ipcMain.handle("summaryHistory:get", (_event, id) => getSummaryHistoryEntry(id));
  ipcMain.handle("justNowTemplate:get", () => ({
    body: readJustNowTemplate(),
    builtIn: !fs.existsSync(justNowTemplatePath())
  }));
  ipcMain.handle("justNowTemplate:update", (_event, input = {}) => writeJustNowTemplate(input.body || ""));
  ipcMain.handle("justNow:recordStart", () => startNativeJustNowRecording());
  ipcMain.handle("justNow:recordStop", () => stopNativeJustNowRecording());
  ipcMain.handle("justNow:summarize", (_event, input = {}) => summarizeJustNow(input || {}));
  ipcMain.handle("justNowHistory:list", () => publicJustNowHistory());
  ipcMain.handle("justNowHistory:get", (_event, id) => getJustNowEntry(id));

  ipcMain.handle("reminders:list", () => sortedReminders());
  ipcMain.handle("reminders:create", (_event, input) => {
    const reminder = normalizeReminderInput(input);
    reminders.push(reminder);
    saveReminders();
    broadcastReminders();
    appendActivity({
      type: "reminder.create",
      title: reminder.title,
      source: reminder.sourceLabel || "提醒",
      detail: reminder.body,
      meta: { dueAt: reminder.dueAt, repeat: reminder.repeat }
    });
    return reminder;
  });
  ipcMain.handle("reminders:update", (_event, input) => {
    const id = String(input?.id || "");
    const index = reminders.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("找不到提醒。");
    reminders[index] = normalizeReminderInput(input, reminders[index]);
    saveReminders();
    broadcastReminders();
    appendActivity({
      type: "reminder.update",
      title: reminders[index].title,
      source: reminders[index].sourceLabel || "提醒",
      detail: reminders[index].body,
      meta: { dueAt: reminders[index].dueAt, repeat: reminders[index].repeat, enabled: reminders[index].enabled }
    });
    return reminders[index];
  });
  ipcMain.handle("reminders:delete", (_event, id) => {
    const targetId = String(id || "");
    const before = reminders.length;
    reminders = reminders.filter((item) => item.id !== targetId);
    if (reminders.length !== before) {
      saveReminders();
      broadcastReminders();
      appendActivity({
        type: "reminder.delete",
        title: targetId,
        source: "提醒"
      });
    }
    return true;
  });
  ipcMain.handle("reminders:snooze", (_event, input = {}) => {
    const reminder = snoozeReminder(input.id, input.minutes);
    if (mascotWindow && !mascotWindow.isDestroyed()) {
      mascotBubbleInteractive = false;
      updateMascotMousePassthroughFromCursor();
    }
    return reminder;
  });
  ipcMain.handle("mascot:triggerAnimation", (_event, payload = {}) => {
    const reminder = {
      title: String(payload.title || "测试提醒"),
      body: String(payload.body || "AI小力提醒动效正常。"),
      sourceLabel: String(payload.sourceLabel || "测试")
    };
    if (mascotWindow && !mascotWindow.isDestroyed()) {
      mascotWindow.show();
      mascotBubbleInteractive = true;
      activeReminderPayload = {
        id: "test",
        title: reminder.title,
        body: reminder.body,
        sourceLabel: reminder.sourceLabel,
        dueAt: new Date().toISOString()
      };
      updateMascotMousePassthroughFromCursor();
      mascotWindow.webContents.send("mascot:remind", reminder);
    }
    return true;
  });
}

app.on("window-all-closed", () => {});

app.on("before-quit", () => {
  clearInterval(reminderTimer);
  clearTimeout(saveBoundsTimer);
  stopMascotMousePoll();
  stopActivityTracking();
});

app.on("activate", () => {
  if (!mascotWindow) createMascotWindow();
  if (settings.mascotVisible && mascotWindow) mascotWindow.show();
});

app.whenReady().then(() => {
  migrateLegacyUserData();
  if (process.platform === "darwin" && app.dock && fs.existsSync(APP_LOGO_PATH)) {
    app.dock.setIcon(nativeImage.createFromPath(APP_LOGO_PATH));
  }
  loadState();
  installPermissionHandlers();
  installIpcHandlers();
  createMascotWindow();
  createTray();
  updateApplicationMenu();
  startActivityTracking();
  startReminderLoop();
});
