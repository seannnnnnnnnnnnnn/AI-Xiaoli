const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const https = require("node:https");
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
  safeStorage,
  shell
} = require("electron");

const APP_NAME = "AI小力";
const APP_SUBTITLE = "桌面 AI 任务助手";
const LEGACY_APP_NAME = "AI小力桌宠";
const APP_LOGO_PATH = path.join(__dirname, "assets", "app-logo.png");
const REMINDER_POLL_MS = 15000;
const MASCOT_INTERACTION_POLL_MS = 30;
const ACTIVITY_POLL_MS = 30000;
const DEFAULT_SNOOZE_MINUTES = 10;
const MASCOT_SIZE = { width: 480, height: 680 };
const MIN_MASCOT_SCALE = 0.7;
const MAX_MASCOT_SCALE = 1.45;
const DEFAULT_TIME_BLOCK_MINUTES = 60;
const SETTINGS_SIZE = { width: 1160, height: 820 };
const SUMMARY_HISTORY_LIMIT = 60;
const TRAY_IDLE_TITLE = "小力";
const TRAY_TASK_TITLE_MAX_LENGTH = 36;
const UPDATE_REPO = "seannnnnnnnnnnnnn/AI-Xiaoli";
const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_STARTUP_DELAY_MS = 9000;
const UPDATE_REQUEST_TIMEOUT_MS = 15000;
const VALID_REPEATS = new Set(["none", "daily", "weekly", "monthly"]);
const VALID_REMINDER_KINDS = new Set(["instant", "timeBlock"]);
const VALID_ARRANGE_ACTIONS = new Set(["history", "instant", "timeBlock"]);
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
let trayTitleText = "";
let reminderTimer = null;
let checkingReminders = false;
let saveBoundsTimer = null;
let mousePollTimer = null;
let mousePassthroughEnabled = null;
let mascotDragState = null;
let mascotResizeState = null;
let mascotBubbleInteractive = false;
let mascotControlsExpanded = false;
let activityTimer = null;
let updateTimer = null;
let currentForeground = null;
let lastForegroundErrorAt = 0;
let lastActivityTrimAt = 0;
let activeReminderPayload = null;
let nativeJustNowSession = null;
let updateState = null;

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
  updates: {
    autoCheck: true,
    ignoredVersion: "",
    lastCheckAt: "",
    lastNotifiedVersion: ""
  },
  mascotBounds: null,
  updatedAt: ""
};

let settings = { ...defaultSettings };
let reminders = [];

app.setName(APP_NAME);
app.setAppUserModelId("ai.xiaoli.mascot");

if (process.env.XIAOLI_USER_DATA_DIR) {
  app.setPath("userData", path.resolve(process.env.XIAOLI_USER_DATA_DIR));
}

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
  settings.updates = normalizeUpdateSettings(settings.updates);
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
  updateState = initialUpdateState();
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

function normalizeUpdateSettings(value = {}) {
  const input = value && typeof value === "object" ? value : {};
  return {
    ...defaultSettings.updates,
    ...input,
    autoCheck: input.autoCheck !== false,
    ignoredVersion: String(input.ignoredVersion || "").trim(),
    lastCheckAt: String(input.lastCheckAt || "").trim(),
    lastNotifiedVersion: String(input.lastNotifiedVersion || "").trim()
  };
}

function currentAppVersion() {
  return String(app.getVersion() || "0.0.0").trim();
}

function initialUpdateState() {
  return {
    checking: false,
    status: "idle",
    currentVersion: currentAppVersion(),
    latestVersion: "",
    hasUpdate: false,
    ignored: false,
    releaseName: "",
    releaseUrl: "",
    releaseNotes: "",
    assetName: "",
    assetSize: 0,
    downloadUrl: "",
    lastCheckedAt: settings.updates?.lastCheckAt || "",
    error: ""
  };
}

function normalizeVersionTag(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split(/[+-]/)[0];
}

function compareVersions(left, right) {
  const leftParts = normalizeVersionTag(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const rightParts = normalizeVersionTag(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function publicUpdateState() {
  if (!updateState) updateState = initialUpdateState();
  return {
    ...updateState,
    currentVersion: currentAppVersion(),
    autoCheck: settings.updates?.autoCheck !== false
  };
}

function broadcastUpdateState() {
  broadcast("updates:changed", publicUpdateState());
  updateTrayMenu();
  updateApplicationMenu();
}

function requestJson(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: {
        "Accept": "application/vnd.github+json",
        "User-Agent": `${APP_NAME}/${currentAppVersion()}`
      },
      timeout: UPDATE_REQUEST_TIMEOUT_MS
    }, (response) => {
      const location = response.headers.location;
      if (response.statusCode >= 300 && response.statusCode < 400 && location && redirectCount < 3) {
        response.resume();
        requestJson(location, redirectCount + 1).then(resolve, reject);
        return;
      }
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 2 * 1024 * 1024) {
          request.destroy(new Error("更新信息过大。"));
        }
      });
      response.on("end", () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`检查更新失败：HTTP ${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error("更新信息解析失败。"));
        }
      });
    });
    request.on("timeout", () => request.destroy(new Error("检查更新超时。")));
    request.on("error", reject);
  });
}

function platformUpdatePatterns() {
  if (process.platform === "darwin") {
    return process.arch === "arm64"
      ? [/macos.*arm64.*\.zip$/i, /darwin.*arm64.*\.zip$/i, /mac.*arm64.*\.zip$/i]
      : [/macos.*x64.*\.zip$/i, /darwin.*x64.*\.zip$/i, /mac.*x64.*\.zip$/i, /mac.*\.zip$/i];
  }
  if (process.platform === "win32") {
    return process.arch === "arm64"
      ? [/windows.*arm64.*\.(zip|exe)$/i, /win.*arm64.*\.(zip|exe)$/i]
      : [/windows.*x64.*\.(zip|exe)$/i, /win.*x64.*\.(zip|exe)$/i, /windows.*\.(zip|exe)$/i];
  }
  return [new RegExp(`${process.platform}.*${process.arch}.*\\.(zip|appimage|deb|rpm)$`, "i")];
}

function selectUpdateAsset(release = {}) {
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const patterns = platformUpdatePatterns();
  for (const pattern of patterns) {
    const match = assets.find((asset) => pattern.test(String(asset.name || "")));
    if (match?.browser_download_url) {
      return {
        name: String(match.name || ""),
        url: String(match.browser_download_url || ""),
        size: Number(match.size || 0)
      };
    }
  }
  return null;
}

function setUpdateState(nextState = {}) {
  updateState = {
    ...initialUpdateState(),
    ...(updateState || {}),
    ...nextState,
    currentVersion: currentAppVersion()
  };
  broadcastUpdateState();
  return publicUpdateState();
}

function shouldCheckUpdatesNow() {
  if (settings.updates?.autoCheck === false) return false;
  const lastMs = new Date(settings.updates?.lastCheckAt || "").getTime();
  return !Number.isFinite(lastMs) || Date.now() - lastMs >= UPDATE_CHECK_INTERVAL_MS;
}

async function checkForUpdates({ manual = false } = {}) {
  if (updateState?.checking) return publicUpdateState();
  setUpdateState({ checking: true, status: "checking", error: "" });
  try {
    const release = await requestJson(UPDATE_API_URL);
    const latestVersion = String(release.tag_name || "").trim();
    if (!latestVersion) throw new Error("最新版本号为空。");
    const asset = selectUpdateAsset(release);
    const hasUpdate = compareVersions(latestVersion, currentAppVersion()) > 0;
    const ignored = hasUpdate && settings.updates?.ignoredVersion === latestVersion;
    const checkedAt = new Date().toISOString();

    settings.updates = normalizeUpdateSettings({
      ...settings.updates,
      lastCheckAt: checkedAt
    });
    saveSettings();

    const state = setUpdateState({
      checking: false,
      status: hasUpdate ? (asset ? "available" : "available-no-asset") : "current",
      latestVersion,
      hasUpdate,
      ignored,
      releaseName: String(release.name || latestVersion),
      releaseUrl: String(release.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`),
      releaseNotes: String(release.body || "").slice(0, 4000),
      assetName: asset?.name || "",
      assetSize: asset?.size || 0,
      downloadUrl: asset?.url || "",
      lastCheckedAt: checkedAt,
      error: ""
    });

    if (hasUpdate && !ignored && !manual) {
      notifyUpdateAvailable(state, { manual });
    }
    return state;
  } catch (error) {
    const state = setUpdateState({
      checking: false,
      status: "error",
      hasUpdate: false,
      ignored: false,
      lastCheckedAt: settings.updates?.lastCheckAt || "",
      error: error?.message || "检查更新失败。"
    });
    if (manual) throw error;
    return state;
  }
}

function notifyUpdateAvailable(state = publicUpdateState(), { manual = false } = {}) {
  if (!state.hasUpdate || state.ignored) return;
  if (!manual && settings.updates?.lastNotifiedVersion === state.latestVersion) return;
  settings.updates = normalizeUpdateSettings({
    ...settings.updates,
    lastNotifiedVersion: state.latestVersion
  });
  saveSettings();
  updateTrayMenu();
  updateApplicationMenu();

  appendActivity({
    type: "app.update.available",
    title: `发现新版本 ${state.latestVersion}`,
    source: APP_NAME,
    detail: state.releaseName || state.assetName || "",
    meta: {
      version: state.latestVersion,
      assetName: state.assetName,
      releaseUrl: state.releaseUrl
    }
  });

  if (mascotWindow && !mascotWindow.isDestroyed()) {
    mascotWindow.webContents.send("mascot:status", {
      source: "软件更新",
      title: `发现 ${state.latestVersion}`,
      body: state.downloadUrl ? "可在设置页一键下载。" : "可在设置页查看更新。",
      autoHideMs: 6500
    });
  }

  if (Notification.isSupported()) {
    const notification = new Notification({
      title: `AI小力有新版本 ${state.latestVersion}`,
      body: state.assetName ? "点击查看并下载新版。" : "点击查看更新说明。",
      silent: true
    });
    notification.on("click", () => createSettingsWindow());
    notification.show();
  }
}

function openUpdateRelease() {
  const state = publicUpdateState();
  const target = state.releaseUrl || `https://github.com/${UPDATE_REPO}/releases/latest`;
  shell.openExternal(target);
  return true;
}

function openUpdateDownload() {
  const state = publicUpdateState();
  const target = state.downloadUrl || state.releaseUrl || `https://github.com/${UPDATE_REPO}/releases/latest`;
  shell.openExternal(target);
  appendActivity({
    type: "app.update.download",
    title: state.latestVersion ? `下载新版本 ${state.latestVersion}` : "打开更新下载",
    source: APP_NAME,
    detail: state.assetName || target,
    meta: {
      version: state.latestVersion,
      assetName: state.assetName,
      releaseUrl: state.releaseUrl
    }
  });
  return true;
}

function ignoreCurrentUpdate() {
  const state = publicUpdateState();
  if (!state.latestVersion || !state.hasUpdate) throw new Error("当前没有可忽略的新版本。");
  settings.updates = normalizeUpdateSettings({
    ...settings.updates,
    ignoredVersion: state.latestVersion
  });
  saveSettings();
  setUpdateState({ ignored: true });
  appendActivity({
    type: "app.update.ignore",
    title: `忽略版本 ${state.latestVersion}`,
    source: APP_NAME,
    detail: state.releaseName || ""
  });
  return publicUpdateState();
}

function startUpdateLoop() {
  clearInterval(updateTimer);
  updateTimer = null;
  if (settings.updates?.autoCheck === false) {
    setUpdateState({ status: "disabled" });
    return;
  }
  updateTimer = setInterval(() => {
    if (shouldCheckUpdatesNow()) checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);
  if (shouldCheckUpdatesNow()) {
    setTimeout(() => checkForUpdates().catch(() => {}), UPDATE_STARTUP_DELAY_MS);
  }
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
  const kind = VALID_REMINDER_KINDS.has(reminder.kind)
    ? reminder.kind
    : (reminder.type === "timeBlock" ? "timeBlock" : "instant");
  const start = new Date(reminder.startAt || reminder.dueAt);
  const due = new Date(reminder.dueAt || reminder.startAt);
  if (!Number.isFinite(due.getTime()) && !Number.isFinite(start.getTime())) return null;
  const normalizedStart = Number.isFinite(start.getTime()) ? start : due;
  let normalizedEnd = reminder.endAt ? new Date(reminder.endAt) : null;
  if (kind === "timeBlock" && (!normalizedEnd || !Number.isFinite(normalizedEnd.getTime()) || normalizedEnd.getTime() <= normalizedStart.getTime())) {
    normalizedEnd = new Date(normalizedStart.getTime() + DEFAULT_TIME_BLOCK_MINUTES * 60 * 1000);
  }
  const nowIso = new Date().toISOString();
  const lastFiredAtDate = reminder.lastFiredAt ? new Date(reminder.lastFiredAt) : null;
  const lastSnoozedAtDate = reminder.lastSnoozedAt ? new Date(reminder.lastSnoozedAt) : null;
  const snoozeReturnDueAtDate = reminder.snoozeReturnDueAt ? new Date(reminder.snoozeReturnDueAt) : null;
  return {
    id: String(reminder.id || crypto.randomUUID()),
    kind,
    title: String(reminder.title || "提醒").trim() || "提醒",
    body: String(reminder.body || "").trim(),
    dueAt: (kind === "timeBlock" || !Number.isFinite(due.getTime()) ? normalizedStart : due).toISOString(),
    startAt: normalizedStart.toISOString(),
    endAt: kind === "timeBlock" ? normalizedEnd.toISOString() : "",
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
    lastFiredForDueAt: String(reminder.lastFiredForDueAt || "").trim(),
    createdAt: reminder.createdAt || nowIso,
    updatedAt: reminder.updatedAt || nowIso
  };
}

function normalizeReminderInput(input, current = {}) {
  const nowIso = new Date().toISOString();
  const kind = VALID_REMINDER_KINDS.has(input?.kind)
    ? input.kind
    : (VALID_REMINDER_KINDS.has(current.kind) ? current.kind : "instant");
  const due = new Date(input?.dueAt ?? input?.startAt ?? current.dueAt ?? current.startAt);
  if (!Number.isFinite(due.getTime())) throw new Error("提醒时间无效。");
  const repeat = input?.repeat ?? current.repeat ?? "none";
  if (!VALID_REPEATS.has(repeat)) {
    throw new Error("重复频率无效。");
  }
  const title = String(input?.title ?? current.title ?? "").trim();
  if (!title) {
    throw new Error("提醒标题不能为空。");
  }
  const enabled = input?.enabled === undefined ? current.enabled !== false : Boolean(input.enabled);
  let normalizedDueAt = "";
  let startAt = due.toISOString();
  let endAt = "";
  if (kind === "timeBlock") {
    const rawEnd = new Date(input?.endAt ?? current.endAt);
    if (!Number.isFinite(rawEnd.getTime())) throw new Error("请选择有效的结束时间。");
    const durationMs = rawEnd.getTime() - due.getTime();
    if (durationMs < 5 * 60 * 1000) throw new Error("时间块至少需要 5 分钟。");
    if (repeat === "none") {
      if (enabled && rawEnd.getTime() <= Date.now() + FUTURE_DUE_GRACE_MS) {
        throw new Error("时间块结束时间需要晚于当前时间。");
      }
      normalizedDueAt = due.toISOString();
    } else {
      normalizedDueAt = normalizeDueAtForSave(due, repeat, enabled);
    }
    const normalizedStart = new Date(normalizedDueAt);
    startAt = normalizedStart.toISOString();
    endAt = new Date(normalizedStart.getTime() + durationMs).toISOString();
  } else {
    normalizedDueAt = normalizeDueAtForSave(due, repeat, enabled);
    startAt = normalizedDueAt;
  }
  return {
    id: current.id || crypto.randomUUID(),
    kind,
    title,
    body: String(input?.body ?? current.body ?? "").trim(),
    dueAt: normalizedDueAt,
    startAt,
    endAt,
    repeat,
    enabled,
    sourceLabel: String(input?.sourceLabel ?? current.sourceLabel ?? "").trim(),
    snoozeCount: Math.max(0, Number.parseInt(String(current.snoozeCount || 0), 10) || 0),
    snoozedFrom: String(current.snoozedFrom || "").trim(),
    lastSnoozedAt: current.lastSnoozedAt || "",
    snoozeReturnDueAt: current.snoozeReturnDueAt || "",
    lastFiredAt: current.lastFiredAt || "",
    lastFiredForDueAt: current.lastFiredForDueAt === normalizedDueAt ? current.lastFiredForDueAt : "",
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
    return new Date(left.startAt || left.dueAt).getTime() - new Date(right.startAt || right.dueAt).getTime();
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
    startAt: original.kind === "timeBlock" ? (original.startAt || original.dueAt) : dueAt,
    enabled: true,
    snoozeCount: (original.snoozeCount || 0) + 1,
    lastSnoozedAt: nowIso,
    snoozeReturnDueAt: original.repeat === "none" ? "" : (original.snoozeReturnDueAt || original.dueAt),
    lastFiredForDueAt: "",
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
  sendCurrentTimeBlockState();
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

function flushMascotResizePreview() {
  if (!mascotResizeState) return;
  if (mascotResizeState.timer) {
    clearTimeout(mascotResizeState.timer);
    mascotResizeState.timer = null;
  }
  const nextScale = normalizedScale(mascotResizeState.pendingScale ?? mascotResizeState.startScale);
  settings.mascotScale = nextScale;
  resizeMascotWindowForScale(nextScale, false);
}

function flushMascotDragPreview() {
  if (!mascotWindow || mascotWindow.isDestroyed() || !mascotDragState?.pendingPoint) return;
  if (mascotDragState.timer) {
    clearTimeout(mascotDragState.timer);
    mascotDragState.timer = null;
  }
  const point = mascotDragState.pendingPoint;
  const dx = Math.round(point.x - mascotDragState.startPoint.x);
  const dy = Math.round(point.y - mascotDragState.startPoint.y);
  mascotWindow.setPosition(
    mascotDragState.startBounds.x + dx,
    mascotDragState.startBounds.y + dy,
    false
  );
}

function setMascotMousePassthrough(ignore) {
  if (!mascotWindow || mascotWindow.isDestroyed()) return;
  const next = Boolean(ignore);
  if ((mascotDragState || mascotResizeState) && next) return;
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

function clampMascotRect(rect, bounds) {
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const right = Math.min(bounds.width, Math.round(rect.x + rect.width));
  const bottom = Math.min(bounds.height, Math.round(rect.y + rect.height));
  const width = right - x;
  const height = bottom - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

function mascotRegionLayout() {
  if (!mascotWindow || mascotWindow.isDestroyed()) {
    return { bodyRegions: [], controls: [], bubble: [] };
  }
  const bounds = mascotWindow.getBounds();
  const scale = normalizedScale(settings.mascotScale);
  const alertZoom = activeReminderPayload && activeReminderPayload.kind !== "timeBlock" ? 1.4 : 1;
  const transformScale = scale * alertZoom;
  const centerX = bounds.width / 2;
  const stageBottom = bounds.height - 8;
  const bodyTop = stageBottom - 385 * transformScale;

  const region = (rect) => clampMascotRect(rect, bounds);
  const bodyRegions = [
    region({
      x: centerX - 118 * transformScale,
      y: bodyTop + 4 * transformScale,
      width: 236 * transformScale,
      height: 148 * transformScale
    }),
    region({
      x: centerX - 138 * transformScale,
      y: bodyTop + 126 * transformScale,
      width: 276 * transformScale,
      height: 210 * transformScale
    }),
    region({
      x: centerX - 92 * transformScale,
      y: bodyTop + 315 * transformScale,
      width: 184 * transformScale,
      height: 52 * transformScale
    })
  ].filter(Boolean);

  const controls = [
    region({
      x: centerX + 84 * transformScale,
      y: stageBottom - 338 * transformScale,
      width: 144 * transformScale,
      height: 60 * transformScale
    }),
    region({
      x: centerX + 104 * transformScale,
      y: stageBottom - 66 * transformScale,
      width: 66 * transformScale,
      height: 66 * transformScale
    })
  ].filter(Boolean);

  const bubble = mascotBubbleInteractive
    ? region({
        x: 0,
        y: 0,
        width: Math.min(bounds.width, 278),
        height: Math.min(bounds.height, 154)
      })
    : null;

  return {
    bodyRegions,
    controls,
    bubble: bubble ? [bubble] : []
  };
}

function mascotInteractiveRegion(expanded = false) {
  const layout = mascotRegionLayout();
  const regions = [
    ...layout.bubble,
    ...layout.bodyRegions
  ];
  const controlsVisible = !activeReminderPayload
    || activeReminderPayload.kind === "timeBlock"
    || Boolean(nativeJustNowSession);
  if (expanded && controlsVisible) regions.push(...layout.controls);
  return regions;
}

function mascotCollapsedInteractiveRegion() {
  const layout = mascotRegionLayout();
  if (mascotBubbleInteractive) {
    return [
      ...layout.bubble,
      ...layout.bodyRegions
    ];
  }
  return layout.bodyRegions;
}

function updateMascotMousePassthroughFromCursor() {
  if (!mascotWindow || mascotWindow.isDestroyed() || !mascotWindow.isVisible()) return;
  if (mascotDragState || mascotResizeState) {
    setMascotMousePassthrough(false);
    return;
  }
  const bounds = mascotWindow.getBounds();
  const cursor = screen.getCursorScreenPoint();
  if (!pointInRect(cursor, bounds)) {
    mascotControlsExpanded = false;
    setMascotMousePassthrough(true);
    return;
  }
  const localPoint = {
    x: cursor.x - bounds.x,
    y: cursor.y - bounds.y
  };
  const overCollapsedRegion = mascotCollapsedInteractiveRegion().some((rect) => pointInRect(localPoint, rect));
  if (overCollapsedRegion) mascotControlsExpanded = true;
  const shouldExposeControls = mascotControlsExpanded || Boolean(nativeJustNowSession);
  const overInteractiveRegion = mascotInteractiveRegion(shouldExposeControls)
    .some((rect) => pointInRect(localPoint, rect));
  if (!overInteractiveRegion) mascotControlsExpanded = false;
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
    if (mascotDragState?.timer) clearTimeout(mascotDragState.timer);
    mascotDragState = null;
    if (mascotResizeState?.timer) clearTimeout(mascotResizeState.timer);
    mascotResizeState = null;
    mascotBubbleInteractive = false;
    mascotControlsExpanded = false;
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

function compactTrayTaskTitle(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= TRAY_TASK_TITLE_MAX_LENGTH) return text;
  return `${text.slice(0, TRAY_TASK_TITLE_MAX_LENGTH - 1)}…`;
}

function updateTrayTaskTitle(timeBlockState = currentTimeBlockState()) {
  if (!tray || process.platform !== "darwin") return;
  const taskTitle = timeBlockState?.active ? compactTrayTaskTitle(timeBlockState.title || "当前任务") : "";
  const nextTitle = taskTitle ? `${TRAY_IDLE_TITLE}｜${taskTitle}` : TRAY_IDLE_TITLE;
  if (trayTitleText !== nextTitle) {
    tray.setTitle(nextTitle);
    trayTitleText = nextTitle;
  }
  tray.setToolTip(taskTitle ? `${APP_NAME} · 当前任务：${taskTitle}` : `${APP_NAME} · ${APP_SUBTITLE}`);
}

function createTray() {
  tray = new Tray(trayImage().resize({ width: 18, height: 18 }));
  updateTrayTaskTitle();
  tray.on("click", () => createSettingsWindow());
  updateTrayMenu();
}

function updateApplicationMenu() {
  const visible = Boolean(settings.mascotVisible);
  const paused = Boolean(settings.paused);
  const pinned = Boolean(settings.notificationBarPinned);
  const updateInfo = publicUpdateState();
  const updateLabel = updateInfo.hasUpdate && !updateInfo.ignored
    ? `下载更新 ${updateInfo.latestVersion}`
    : "检查更新";
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
        {
          label: updateLabel,
          click: () => {
            if (updateInfo.hasUpdate && !updateInfo.ignored) openUpdateDownload();
            else checkForUpdates({ manual: true }).catch((error) => {
              if (Notification.isSupported()) {
                new Notification({ title: "AI小力检查更新失败", body: error?.message || "请稍后重试。" }).show();
              }
            });
          }
        },
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
  const updateInfo = publicUpdateState();
  const updateItems = updateInfo.hasUpdate && !updateInfo.ignored
    ? [
        { label: `下载更新 ${updateInfo.latestVersion}`, click: openUpdateDownload },
        { label: "查看更新说明", click: openUpdateRelease }
      ]
    : [
        {
          label: updateInfo.checking ? "正在检查更新..." : "检查更新",
          enabled: !updateInfo.checking,
          click: () => checkForUpdates({ manual: true }).catch((error) => {
            if (Notification.isSupported()) {
              new Notification({ title: "AI小力检查更新失败", body: error?.message || "请稍后重试。" }).show();
            }
          })
        }
      ];
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "添加提醒", click: showSettingsAndFocusForm },
    { label: "查看提醒", click: createSettingsWindow },
    { label: "AI 总结", click: showSettingsAndFocusAi },
    { label: "刚刚发生了啥", click: () => showSettingsAndFocusJustNow() },
    ...updateItems,
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
  if (patch.updates && typeof patch.updates === "object") {
    const wasAutoCheck = settings.updates?.autoCheck !== false;
    settings.updates = normalizeUpdateSettings({
      ...settings.updates,
      ...patch.updates
    });
    if (wasAutoCheck !== (settings.updates.autoCheck !== false)) {
      setTimeout(startUpdateLoop, 0);
    }
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
  broadcastUpdateState();
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
    sendCurrentTimeBlockState();
  }
}

function currentTimeBlockState(nowMs = Date.now()) {
  const active = sortedReminders().find((reminder) => {
    if (!reminder.enabled || reminder.kind !== "timeBlock") return false;
    const startMs = new Date(reminder.startAt || reminder.dueAt).getTime();
    const endMs = new Date(reminder.endAt).getTime();
    return Number.isFinite(startMs) && Number.isFinite(endMs) && startMs <= nowMs && endMs > nowMs;
  });
  if (!active) return { active: false };
  const startMs = new Date(active.startAt || active.dueAt).getTime();
  const endMs = new Date(active.endAt).getTime();
  const progress = Math.min(Math.max((nowMs - startMs) / Math.max(endMs - startMs, 1), 0), 1);
  return {
    active: true,
    id: active.id,
    title: active.title,
    body: active.body,
    sourceLabel: active.sourceLabel,
    startAt: active.startAt || active.dueAt,
    endAt: active.endAt,
    startAtLocal: formatLocalDateTime(active.startAt || active.dueAt),
    endAtLocal: formatLocalDateTime(active.endAt),
    progress
  };
}

function sendCurrentTimeBlockState() {
  const state = currentTimeBlockState();
  updateTrayTaskTitle(state);
  if (mascotWindow && !mascotWindow.isDestroyed()) {
    mascotWindow.webContents.send("mascot:timeBlock", state);
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
          kind: String(event.meta.kind || "").slice(0, 20),
          previousDueAt: String(event.meta.previousDueAt || "").slice(0, 40),
          previousDueAtLocal: formatLocalDateTime(event.meta.previousDueAt, { seconds: true }) || undefined,
          dueAt: String(event.meta.dueAt || "").slice(0, 40),
          dueAtLocal: formatLocalDateTime(event.meta.dueAt, { seconds: true }) || undefined,
          startAt: String(event.meta.startAt || "").slice(0, 40),
          startAtLocal: formatLocalDateTime(event.meta.startAt, { seconds: true }) || undefined,
          endAt: String(event.meta.endAt || "").slice(0, 40),
          endAtLocal: formatLocalDateTime(event.meta.endAt, { seconds: true }) || undefined,
          repeat: String(event.meta.repeat || "").slice(0, 20),
          inputMode: String(event.meta.inputMode || "").slice(0, 40),
          minutes: Number.isFinite(Number(event.meta.minutes)) ? Number(event.meta.minutes) : undefined,
          snoozeCount: Number.isFinite(Number(event.meta.snoozeCount)) ? Number(event.meta.snoozeCount) : undefined,
          snoozeReturnDueAt: String(event.meta.snoozeReturnDueAt || "").slice(0, 40),
          snoozeReturnDueAtLocal: formatLocalDateTime(event.meta.snoozeReturnDueAt, { seconds: true }) || undefined,
          scale: Number.isFinite(Number(event.meta.scale)) ? Number(event.meta.scale) : undefined,
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
  const timeBlockEndCount = stats.counts["timeblock.end"] || 0;
  const latest = events.slice(-6).map((event) => {
    const time = new Date(event.ts).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    return `- ${time} ${event.source || event.type}：${event.title || event.detail || event.type}`;
  }).join("\n");
  return [
    `${label}本地统计：共记录 ${stats.totalEvents} 条活动。${appLine}`,
    `提醒相关事件 ${reminderCount} 条，时间块结束 ${timeBlockEndCount} 条，拖延/稍后提醒 ${snoozeCount} 条；聆听 ${stats.counts["mascot.listen"] || 0} 条，桌宠拖动/缩放 ${(stats.counts["mascot.drag"] || 0) + (stats.counts["mascot.resize"] || 0)} 条。`,
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

function parseJsonFromModelText(text) {
  const raw = String(text || "").trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(raw);
  } catch {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(raw.slice(first, last + 1));
  }
  throw new Error("LLM 没有返回有效的安排 JSON。");
}

function compactArrangeText(value, maxLength = 120) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.slice(0, maxLength);
}

function parseArrangeDate(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label}时间无效。`);
  return date;
}

function normalizeArrangePlan(plan = {}, input = {}) {
  const nowMs = Date.now();
  const originalText = compactArrangeText(input.originalText || plan.originalText || "", 1000);
  const rawActions = Array.isArray(plan.actions) ? plan.actions : [];
  if (!rawActions.length) throw new Error("没有识别到可执行的安排。");
  const actions = rawActions.slice(0, 8).map((raw, index) => {
    const type = String(raw?.type || "").trim();
    if (!VALID_ARRANGE_ACTIONS.has(type)) throw new Error(`第 ${index + 1} 个动作类型无效。`);
    const title = compactArrangeText(raw.title || raw.name || "", 80);
    if (!title) throw new Error(`第 ${index + 1} 个动作缺少标题。`);
    const base = {
      id: String(raw.id || crypto.randomUUID()),
      type,
      title,
      body: compactArrangeText(raw.body || raw.detail || "", 400),
      sourceLabel: compactArrangeText(raw.sourceLabel || raw.source || "直接安排", 40) || "直接安排",
      repeat: VALID_REPEATS.has(raw.repeat) ? raw.repeat : "none",
      originalText
    };
    if (type === "history") {
      const start = parseArrangeDate(raw.startAt, "历史动作开始");
      const end = parseArrangeDate(raw.endAt, "历史动作结束");
      if (end.getTime() <= start.getTime()) throw new Error(`历史动作“${title}”的结束时间必须晚于开始时间。`);
      if (start.getTime() > nowMs + 60 * 1000 || end.getTime() > nowMs + 60 * 1000) {
        throw new Error(`历史动作“${title}”不能晚于当前时间。`);
      }
      return {
        ...base,
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        durationMs: end.getTime() - start.getTime(),
        startAtLocal: formatLocalDateTime(start, { seconds: true }),
        endAtLocal: formatLocalDateTime(end, { seconds: true })
      };
    }
    if (type === "instant") {
      const due = parseArrangeDate(raw.dueAt || raw.startAt, "单点提醒");
      if (due.getTime() <= nowMs + FUTURE_DUE_GRACE_MS) throw new Error(`单点提醒“${title}”需要是未来时间。`);
      return {
        ...base,
        dueAt: due.toISOString(),
        startAt: due.toISOString(),
        endAt: "",
        dueAtLocal: formatLocalDateTime(due, { seconds: true })
      };
    }
    const start = parseArrangeDate(raw.startAt || raw.dueAt, "时间块开始");
    const end = parseArrangeDate(raw.endAt, "时间块结束");
    if (end.getTime() <= start.getTime()) throw new Error(`时间块“${title}”的结束时间必须晚于开始时间。`);
    if (end.getTime() <= nowMs + FUTURE_DUE_GRACE_MS) throw new Error(`时间块“${title}”的结束时间需要晚于当前时间。`);
    if (end.getTime() - start.getTime() < 5 * 60 * 1000) throw new Error(`时间块“${title}”至少需要 5 分钟。`);
    return {
      ...base,
      startAt: start.toISOString(),
      dueAt: start.toISOString(),
      endAt: end.toISOString(),
      startAtLocal: formatLocalDateTime(start, { seconds: true }),
      endAtLocal: formatLocalDateTime(end, { seconds: true })
    };
  });
  return {
    summary: compactArrangeText(plan.summary || "请确认下面的安排。", 160),
    originalText,
    createdAt: new Date().toISOString(),
    actions
  };
}

async function previewLanguageArrange(input = {}) {
  const text = String(input.text || "").trim();
  if (!text) throw new Error("请输入要安排的内容。");
  const ai = normalizeAiSettings(settings.ai);
  if (!ai.enabled) throw new Error("请先在 AI小力设置里启用通用 LLM API。");
  const now = new Date();
  const today = `${now.getFullYear()}-${padTimePart(now.getMonth() + 1)}-${padTimePart(now.getDate())}`;
  const content = await callAiChat([
    {
      role: "system",
      content: [
        "你是 AI小力的自然语言任务安排解析器。",
        "你的任务是把用户输入解析成可执行 JSON，不要执行，不要解释，不要输出 Markdown。",
        "只能输出一个 JSON 对象，结构为：",
        "{\"summary\":\"一句话概括\",\"actions\":[{\"type\":\"history|instant|timeBlock\",\"title\":\"标题\",\"body\":\"备注\",\"sourceLabel\":\"来源标签\",\"startAt\":\"ISO时间\",\"endAt\":\"ISO时间\",\"dueAt\":\"ISO时间\",\"repeat\":\"none\"}]}",
        "三类动作含义：history=已经发生的历史动作；instant=未来单点提醒；timeBlock=未来开始-结束时间块。",
        "用户没有规定日期时，默认日期必须是今天。",
        "用户使用“刚刚/过去/前半小时/刚才”等描述时，创建 history，并根据当前时间倒推 startAt/endAt。",
        "用户使用“未来/接下来/稍后/明天/下午/晚上”等安排未来工作区间时，创建 timeBlock。",
        "用户只说某个时间点提醒时，创建 instant。",
        "所有时间必须是可被 JavaScript Date 解析的 ISO 8601 字符串，尽量带本地时区偏移。",
        "不要生成删除、修改或查询动作。无法确定时宁可少生成动作。"
      ].join("\n")
    },
    {
      role: "user",
      content: [
        `当前本地时间：${formatLocalDateTime(now, { seconds: true })}`,
        `当前 ISO：${now.toISOString()}`,
        `本机时区：${localTimeZoneLabel()}`,
        `默认日期：${today}`,
        "",
        `用户输入：${text}`
      ].join("\n")
    }
  ]);
  const parsed = parseJsonFromModelText(content);
  return normalizeArrangePlan(parsed, { originalText: text });
}

function commitLanguageArrange(input = {}) {
  const plan = normalizeArrangePlan(input.plan || {}, { originalText: input.originalText || input.plan?.originalText || "" });
  const nowIso = new Date().toISOString();
  const created = {
    history: [],
    reminders: []
  };
  let remindersChanged = false;

  for (const action of plan.actions) {
    if (action.type === "history") {
      const record = appendActivity({
        ts: action.startAt,
        type: "manual.history",
        title: action.title,
        source: action.sourceLabel || "直接安排",
        detail: action.body,
        startedAt: action.startAt,
        endedAt: action.endAt,
        durationMs: action.durationMs,
        meta: {
          inputMode: "language",
          originalText: plan.originalText
        }
      });
      created.history.push(record);
      continue;
    }
    const reminder = normalizeReminderInput({
      kind: action.type === "timeBlock" ? "timeBlock" : "instant",
      title: action.title,
      body: action.body,
      dueAt: action.dueAt || action.startAt,
      startAt: action.startAt || action.dueAt,
      endAt: action.type === "timeBlock" ? action.endAt : "",
      repeat: action.repeat || "none",
      enabled: true,
      sourceLabel: action.sourceLabel || "直接安排",
      inputMode: "language"
    });
    reminders.push(reminder);
    remindersChanged = true;
    created.reminders.push(reminder);
    appendActivity({
      type: "reminder.create",
      title: reminder.title,
      source: reminder.sourceLabel || "提醒",
      detail: reminder.body,
      meta: {
        kind: reminder.kind || "instant",
        dueAt: reminder.dueAt,
        startAt: reminder.startAt || reminder.dueAt,
        endAt: reminder.endAt || "",
        repeat: reminder.repeat,
        inputMode: "language",
        originalText: plan.originalText
      }
    });
  }

  appendActivity({
    type: "language.arrange",
    title: "直接安排",
    source: APP_NAME,
    detail: plan.originalText,
    meta: {
      historyCount: created.history.length,
      reminderCount: created.reminders.length
    }
  });

  if (remindersChanged) {
    saveReminders();
    broadcastReminders();
  }

  return {
    ok: true,
    committedAt: nowIso,
    plan,
    created: {
      historyCount: created.history.length,
      reminderCount: created.reminders.length,
      reminders: created.reminders
    }
  };
}

async function summarizeActivities(input = {}) {
  const { start, end, label } = resolveActivityRange(input);
  const reviewTemplate = resolveSummaryTemplate(input.templateId);
  const events = readActivityEvents({ start, end });
  const stats = summarizeActivityStats(events);
  const activeTimeBlock = currentTimeBlockState();
  const remindersSnapshot = sortedReminders().slice(0, 80).map((reminder) => ({
    title: reminder.title,
    body: reminder.body,
    kind: reminder.kind || "instant",
    dueAt: reminder.dueAt,
    dueAtLocal: formatLocalDateTime(reminder.dueAt, { seconds: true }),
    startAt: reminder.startAt || reminder.dueAt,
    startAtLocal: formatLocalDateTime(reminder.startAt || reminder.dueAt, { seconds: true }),
    endAt: reminder.endAt || "",
    endAtLocal: formatLocalDateTime(reminder.endAt, { seconds: true }),
    repeat: reminder.repeat,
    enabled: reminder.enabled,
    sourceLabel: reminder.sourceLabel,
    lastFiredAt: reminder.lastFiredAt,
    lastFiredAtLocal: formatLocalDateTime(reminder.lastFiredAt, { seconds: true }),
    timeBlockProgress: reminder.kind === "timeBlock" && reminder.enabled
      ? activeTimeBlock.id === reminder.id ? activeTimeBlock.progress : undefined
      : undefined
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
        "如果提醒数据里 kind=timeBlock，代表用户规划了一个开始-结束时间块；复盘时要区分计划时间、开始提醒、结束记录和稍后提醒。",
        "如果活动日志里出现 reminder.snooze，要把它视为任务拖延/稍后提醒信号；如果出现 timeblock.end，要把它视为时间块结束信号，可用于总结计划执行情况。",
        "用户会提供一个 Markdown 复盘模板，它是本次总结的前置需求模板；在不违背真实性和安全限制的前提下优先遵循。",
        "输出中文 HTML 片段，不要输出 Markdown，不要输出完整 html/body/head。",
        "只允许使用这些标签：article、section、h3、p、ul、li、strong、span。",
        "最外层使用 <article class=\"review-card\">。",
        "结构要适合在桌面应用内展示，包含：总体判断、时间线、计划时间块执行情况、主要成果、注意力分布、待跟进建议。",
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
    kind: reminder.kind,
    title: reminder.title,
    body: reminder.body,
    sourceLabel: reminder.sourceLabel,
    dueAt: reminder.dueAt,
    startAt: reminder.startAt || reminder.dueAt,
    endAt: reminder.endAt || ""
  };
  appendActivity({
    type: "reminder.fire",
    title: reminder.title,
    source: reminder.sourceLabel || "提醒",
    detail: reminder.body,
    meta: {
      dueAt: reminder.dueAt,
      startAt: reminder.startAt || reminder.dueAt,
      endAt: reminder.endAt || "",
      kind: reminder.kind || "instant",
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

function advanceReminderAfterFire(reminder, nowMs) {
  if (reminder.kind === "timeBlock") {
    const startMs = new Date(reminder.startAt || reminder.dueAt).getTime();
    const endMs = new Date(reminder.endAt).getTime();
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs
      ? endMs - startMs
      : DEFAULT_TIME_BLOCK_MINUTES * 60 * 1000;
    if (Number.isFinite(endMs) && endMs > nowMs) return;
    appendActivity({
      type: "timeblock.end",
      title: reminder.title,
      source: reminder.sourceLabel || "时间块",
      detail: reminder.body,
      meta: {
        reminderId: reminder.id,
        startAt: reminder.startAt || reminder.dueAt,
        endAt: reminder.endAt || "",
        repeat: reminder.repeat
      }
    });
    if (reminder.repeat === "none") {
      reminder.enabled = false;
      return;
    }
    const nextStart = nextDueAt(reminder.startAt || reminder.dueAt, reminder.repeat, nowMs);
    if (!nextStart) {
      reminder.enabled = false;
      return;
    }
    reminder.startAt = nextStart;
    reminder.dueAt = nextStart;
    reminder.endAt = new Date(new Date(nextStart).getTime() + durationMs).toISOString();
    reminder.snoozeReturnDueAt = "";
    reminder.lastFiredForDueAt = "";
    return;
  }

  if (reminder.repeat === "none") {
    reminder.enabled = false;
    return;
  }
  const returnDueMs = new Date(reminder.snoozeReturnDueAt || "").getTime();
  const baseDueAt = Number.isFinite(returnDueMs) ? reminder.snoozeReturnDueAt : reminder.dueAt;
  const next = Number.isFinite(returnDueMs) && returnDueMs > nowMs
    ? reminder.snoozeReturnDueAt
    : nextDueAt(baseDueAt, reminder.repeat, nowMs);
  if (next) {
    reminder.dueAt = next;
    reminder.startAt = next;
  } else {
    reminder.enabled = false;
  }
  reminder.snoozeReturnDueAt = "";
}

function checkDueReminders() {
  if (checkingReminders) return;
  if (settings.paused) {
    sendCurrentTimeBlockState();
    return;
  }
  checkingReminders = true;
  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let changed = false;
    for (const reminder of reminders) {
      if (!reminder.enabled) continue;
      const dueMs = new Date(reminder.dueAt).getTime();
      if (!Number.isFinite(dueMs)) continue;
      const alreadyFiredForDueAt = reminder.lastFiredForDueAt === reminder.dueAt;
      if (dueMs <= nowMs && !alreadyFiredForDueAt) {
        fireReminder(reminder);
        reminder.lastFiredAt = nowIso;
        reminder.lastFiredForDueAt = reminder.dueAt;
        reminder.updatedAt = nowIso;
        advanceReminderAfterFire(reminder, nowMs);
        changed = true;
        continue;
      }
      if (reminder.kind === "timeBlock" && alreadyFiredForDueAt) {
        const endMs = new Date(reminder.endAt).getTime();
        if (Number.isFinite(endMs) && endMs <= nowMs) {
          advanceReminderAfterFire(reminder, nowMs);
          reminder.updatedAt = nowIso;
          changed = true;
        }
      }
    }
    if (changed) {
      saveReminders();
      broadcastReminders();
    }
    sendCurrentTimeBlockState();
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
    if (!["mascot.listen", "mascot.drag", "mascot.resize"].includes(type)) return;
    appendActivity({
      type,
      title: String(payload.title || "").slice(0, 120),
      source: APP_NAME,
      detail: String(payload.detail || "").slice(0, 260),
      meta: payload.meta && typeof payload.meta === "object"
        ? {
            scale: Number.isFinite(Number(payload.meta.scale)) ? Number(payload.meta.scale) : undefined
          }
        : undefined
    });
  });
  ipcMain.on("mascot:dragStart", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    mascotDragState = {
      startPoint: { x, y },
      startBounds: mascotWindow.getBounds(),
      pendingPoint: null,
      timer: null
    };
    setMascotMousePassthrough(false);
  });
  ipcMain.on("mascot:dragMove", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents || !mascotDragState) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    mascotDragState.pendingPoint = { x, y };
    if (!mascotDragState.timer) {
      mascotDragState.timer = setTimeout(() => {
        if (!mascotDragState) return;
        mascotDragState.timer = null;
        flushMascotDragPreview();
      }, 16);
    }
  });
  ipcMain.on("mascot:dragEnd", (event) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    flushMascotDragPreview();
    mascotDragState = null;
    settings.mascotBounds = mascotWindow.getBounds();
    saveSettings();
    updateMascotMousePassthroughFromCursor();
  });
  ipcMain.on("mascot:resizeStart", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    mascotResizeState = {
      startPoint: { x, y },
      startScale: normalizedScale(settings.mascotScale),
      startBounds: mascotWindow.getBounds(),
      pendingScale: normalizedScale(settings.mascotScale),
      timer: null
    };
    setMascotMousePassthrough(false);
  });
  ipcMain.on("mascot:resizeMove", (event, point = {}) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents || !mascotResizeState) return;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const dx = x - mascotResizeState.startPoint.x;
    const dy = y - mascotResizeState.startPoint.y;
    const delta = Math.max(dx, dy);
    mascotResizeState.pendingScale = normalizedScale(mascotResizeState.startScale + delta / 360);
  });
  ipcMain.on("mascot:resizeEnd", (event) => {
    if (!mascotWindow || event.sender !== mascotWindow.webContents) return;
    if (!mascotResizeState) return;
    const startScale = normalizedScale(mascotResizeState?.startScale);
    flushMascotResizePreview();
    const finalScale = normalizedScale(settings.mascotScale);
    mascotResizeState = null;
    settings.mascotBounds = mascotWindow.getBounds();
    saveSettings();
    broadcastSettings();
    if (Math.abs(finalScale - startScale) >= 0.01) {
      appendActivity({
        type: "mascot.resize",
        title: "调整小力大小",
        source: APP_NAME,
        detail: `${Math.round(startScale * 100)}% -> ${Math.round(finalScale * 100)}%`,
        meta: { scale: finalScale }
      });
    }
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
  ipcMain.handle("updates:get", () => publicUpdateState());
  ipcMain.handle("updates:check", () => checkForUpdates({ manual: true }));
  ipcMain.handle("updates:openRelease", () => openUpdateRelease());
  ipcMain.handle("updates:openDownload", () => openUpdateDownload());
  ipcMain.handle("updates:ignore", () => ignoreCurrentUpdate());
  ipcMain.handle("arrange:preview", (_event, input = {}) => previewLanguageArrange(input || {}));
  ipcMain.handle("arrange:commit", (_event, input = {}) => commitLanguageArrange(input || {}));
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
      meta: {
        kind: reminder.kind || "instant",
        dueAt: reminder.dueAt,
        startAt: reminder.startAt || reminder.dueAt,
        endAt: reminder.endAt || "",
        repeat: reminder.repeat,
        inputMode: String(input?.inputMode || "").slice(0, 40)
      }
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
      meta: {
        kind: reminders[index].kind || "instant",
        dueAt: reminders[index].dueAt,
        startAt: reminders[index].startAt || reminders[index].dueAt,
        endAt: reminders[index].endAt || "",
        repeat: reminders[index].repeat,
        inputMode: String(input?.inputMode || "").slice(0, 40),
        enabled: reminders[index].enabled
      }
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
  clearInterval(updateTimer);
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
  startUpdateLoop();
});
