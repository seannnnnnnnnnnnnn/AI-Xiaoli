const form = document.querySelector("#reminderForm");
const formTitle = document.querySelector("#formTitle");
const resetFormBtn = document.querySelector("#resetFormBtn");
const titleInput = document.querySelector("#titleInput");
const bodyInput = document.querySelector("#bodyInput");
const dueInput = document.querySelector("#dueInput");
const endInput = document.querySelector("#endInput");
const endTimeField = document.querySelector("#endTimeField");
const repeatField = document.querySelector("#repeatField");
const reminderKindInputs = Array.from(document.querySelectorAll("input[name='reminderKind']"));
const repeatInput = document.querySelector("#repeatInput");
const sourceInput = document.querySelector("#sourceInput");
const saveReminderBtn = document.querySelector("#saveReminderBtn");
const pausedInput = document.querySelector("#pausedInput");
const visibleInput = document.querySelector("#visibleInput");
const pinnedBarInput = document.querySelector("#pinnedBarInput");
const mascotScaleInput = document.querySelector("#mascotScaleInput");
const mascotScaleValue = document.querySelector("#mascotScaleValue");
const autoLaunchInput = document.querySelector("#autoLaunchInput");
const testAnimationBtn = document.querySelector("#testAnimationBtn");
const reminderList = document.querySelector("#reminderList");
const reminderCount = document.querySelector("#reminderCount");
const toastNode = document.querySelector("#toast");
const searchInput = document.querySelector("#searchInput");
const listEyebrow = document.querySelector("#listEyebrow");
const listTitle = document.querySelector("#listTitle");
const listSubtitle = document.querySelector("#listSubtitle");
const filterHint = document.querySelector("#filterHint");
const nextReminderPreview = document.querySelector("#nextReminderPreview");
const pauseStatusText = document.querySelector("#pauseStatusText");
const newReminderBtn = document.querySelector("#newReminderBtn");
const sourceList = document.querySelector("#sourceList");
const focusMascotSettingsBtn = document.querySelector("#focusMascotSettingsBtn");
const focusAiBtn = document.querySelector("#focusAiBtn");
const focusJustNowBtn = document.querySelector("#focusJustNowBtn");
const reminderEditor = document.querySelector("#reminderEditor");
const mascotSettingsPanel = document.querySelector("#mascotSettingsPanel");
const aiPanel = document.querySelector("#aiPanel");
const justNowPanel = document.querySelector("#justNowPanel");
const aiConfigForm = document.querySelector("#aiConfigForm");
const aiStatus = document.querySelector("#aiStatus");
const aiBaseUrlInput = document.querySelector("#aiBaseUrlInput");
const aiModelInput = document.querySelector("#aiModelInput");
const aiChatPathInput = document.querySelector("#aiChatPathInput");
const aiApiKeyInput = document.querySelector("#aiApiKeyInput");
const aiEnabledInput = document.querySelector("#aiEnabledInput");
const activityTrackingInput = document.querySelector("#activityTrackingInput");
const saveAiConfigBtn = document.querySelector("#saveAiConfigBtn");
const testAiBtn = document.querySelector("#testAiBtn");
const aiPromptInput = document.querySelector("#aiPromptInput");
const aiSummaryOutput = document.querySelector("#aiSummaryOutput");
const customRangeFields = document.querySelector("#customRangeFields");
const summaryStartInput = document.querySelector("#summaryStartInput");
const summaryEndInput = document.querySelector("#summaryEndInput");
const generateSummaryBtn = document.querySelector("#generateSummaryBtn");
const summaryTemplateSelect = document.querySelector("#summaryTemplateSelect");
const editSummaryTemplateBtn = document.querySelector("#editSummaryTemplateBtn");
const summaryTemplateForm = document.querySelector("#summaryTemplateForm");
const summaryTemplateNameInput = document.querySelector("#summaryTemplateNameInput");
const summaryTemplateBodyInput = document.querySelector("#summaryTemplateBodyInput");
const saveSummaryTemplateBtn = document.querySelector("#saveSummaryTemplateBtn");
const deleteSummaryTemplateBtn = document.querySelector("#deleteSummaryTemplateBtn");
const summaryHistorySelect = document.querySelector("#summaryHistorySelect");
const openSummaryHistoryBtn = document.querySelector("#openSummaryHistoryBtn");
const justNowTranscriptInput = document.querySelector("#justNowTranscriptInput");
const summarizeJustNowTextBtn = document.querySelector("#summarizeJustNowTextBtn");
const justNowTemplateInput = document.querySelector("#justNowTemplateInput");
const saveJustNowTemplateBtn = document.querySelector("#saveJustNowTemplateBtn");
const justNowHistorySelect = document.querySelector("#justNowHistorySelect");
const openJustNowHistoryBtn = document.querySelector("#openJustNowHistoryBtn");
const justNowOutput = document.querySelector("#justNowOutput");

let reminders = [];
let settings = {};
let aiConfig = {};
let summaryTemplates = [];
let summaryHistory = [];
let justNowHistory = [];
let activeJustNowId = "";
let editingTemplateId = "";
let editingId = "";
let toastTimer = null;
let activeFilter = "today";
let activeSource = "";
let searchText = "";
let selectedSummaryRange = "today";

const repeatLabels = {
  none: "不重复",
  daily: "每天",
  weekly: "每周",
  monthly: "每月"
};

const filterLabels = {
  today: "今天",
  scheduled: "计划中",
  all: "全部",
  disabled: "已停用"
};

function toast(message) {
  clearTimeout(toastTimer);
  toastNode.textContent = message;
  toastNode.hidden = false;
  toastTimer = setTimeout(() => {
    toastNode.hidden = true;
  }, 2600);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function startOfDay(date = new Date()) {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function isSameDay(left, right = new Date()) {
  return startOfDay(left).getTime() === startOfDay(right).getTime();
}

function isTomorrow(date) {
  const tomorrow = startOfDay(new Date());
  tomorrow.setDate(tomorrow.getDate() + 1);
  return startOfDay(date).getTime() === tomorrow.getTime();
}

function localInputValue(date = new Date()) {
  const local = new Date(date);
  return [
    local.getFullYear(),
    "-",
    pad(local.getMonth() + 1),
    "-",
    pad(local.getDate()),
    "T",
    pad(local.getHours()),
    ":",
    pad(local.getMinutes())
  ].join("");
}

function localDateValue(date = new Date()) {
  const local = new Date(date);
  return [
    local.getFullYear(),
    "-",
    pad(local.getMonth() + 1),
    "-",
    pad(local.getDate())
  ].join("");
}

function isoFromLocalInput(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("请选择有效的提醒时间。");
  return date.toISOString();
}

function formatDue(iso, reminder = {}) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "时间无效";
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
  if (!reminder.enabled && reminder.lastFiredAt && reminder.repeat === "none") return `已提醒 ${time}`;
  if (reminder.enabled && date.getTime() < Date.now()) return `已过期 ${time}`;
  if (isSameDay(date)) return `今天 ${time}`;
  if (isTomorrow(date)) return `明天 ${time}`;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatTimeOnly(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function isTimeBlock(reminder) {
  return reminder?.kind === "timeBlock";
}

function formatReminderSchedule(reminder) {
  if (!isTimeBlock(reminder)) return formatDue(reminder.dueAt, reminder);
  const start = new Date(reminder.startAt || reminder.dueAt);
  const end = new Date(reminder.endAt);
  const range = `${formatTimeOnly(start)}-${formatTimeOnly(end)}`;
  if (isSameDay(start)) return `今天 ${range}`;
  if (isTomorrow(start)) return `明天 ${range}`;
  return `${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", weekday: "short" }).format(start)} ${range}`;
}

function timeBlockProgress(reminder) {
  if (!isTimeBlock(reminder)) return null;
  const startMs = new Date(reminder.startAt || reminder.dueAt).getTime();
  const endMs = new Date(reminder.endAt).getTime();
  const nowMs = Date.now();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || nowMs < startMs || nowMs > endMs) return null;
  return Math.min(Math.max((nowMs - startMs) / (endMs - startMs), 0), 1);
}

function dueClass(reminder) {
  const dueMs = new Date(reminder.startAt || reminder.dueAt).getTime();
  if (!Number.isFinite(dueMs)) return "";
  if (timeBlockProgress(reminder) !== null) return "due-active";
  if (reminder.enabled && dueMs < Date.now()) return "due-overdue";
  if (isSameDay(new Date(dueMs))) return "due-today";
  return "";
}

function escapeHtml(text) {
  return String(text || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function defaultDueDate() {
  return new Date(Date.now() + 5 * 60 * 1000);
}

function defaultEndDate(start = defaultDueDate()) {
  return new Date(start.getTime() + 60 * 60 * 1000);
}

function reminderKind() {
  return reminderKindInputs.find((input) => input.checked)?.value === "timeBlock" ? "timeBlock" : "instant";
}

function setReminderKind(kind) {
  const target = kind === "timeBlock" ? "timeBlock" : "instant";
  reminderKindInputs.forEach((input) => {
    input.checked = input.value === target;
  });
  const isTimeBlock = target === "timeBlock";
  endTimeField.hidden = !isTimeBlock;
  repeatField.classList.toggle("repeat-field-compact", isTimeBlock);
  if (isTimeBlock && !endInput.value) {
    endInput.value = localInputValue(defaultEndDate(new Date(dueInput.value || defaultDueDate())));
  }
}

function setInspectorMode(mode) {
  const target = ["reminder", "mascot", "ai", "justNow"].includes(mode) ? mode : "reminder";
  reminderEditor.classList.toggle("active", target === "reminder");
  mascotSettingsPanel.classList.toggle("active", target === "mascot");
  aiPanel.classList.toggle("active", target === "ai");
  justNowPanel.classList.toggle("active", target === "justNow");
  focusMascotSettingsBtn.classList.toggle("active", target === "mascot");
  focusAiBtn.classList.toggle("active", target === "ai");
  focusJustNowBtn.classList.toggle("active", target === "justNow");
}

function resetForm() {
  editingId = "";
  formTitle.textContent = "添加提醒";
  saveReminderBtn.textContent = "保存提醒";
  resetFormBtn.hidden = true;
  titleInput.value = "";
  bodyInput.value = "";
  const start = defaultDueDate();
  dueInput.value = localInputValue(start);
  endInput.value = localInputValue(defaultEndDate(start));
  setReminderKind("instant");
  repeatInput.value = "none";
  sourceInput.value = "";
  setInspectorMode("reminder");
  renderReminders(reminders);
  titleInput.focus();
}

function fillForm(reminder) {
  editingId = reminder.id;
  formTitle.textContent = "编辑提醒";
  saveReminderBtn.textContent = "保存修改";
  resetFormBtn.hidden = false;
  titleInput.value = reminder.title;
  bodyInput.value = reminder.body || "";
  setReminderKind(reminder.kind === "timeBlock" ? "timeBlock" : "instant");
  const start = new Date(reminder.startAt || reminder.dueAt);
  dueInput.value = localInputValue(start);
  endInput.value = reminder.kind === "timeBlock" && reminder.endAt
    ? localInputValue(new Date(reminder.endAt))
    : localInputValue(defaultEndDate(start));
  repeatInput.value = reminder.repeat;
  sourceInput.value = reminder.sourceLabel || "";
  setInspectorMode("reminder");
  renderReminders(reminders);
  titleInput.focus();
}

function reminderPayload() {
  const kind = reminderKind();
  const startAt = isoFromLocalInput(dueInput.value);
  const payload = {
    id: editingId || undefined,
    kind,
    title: titleInput.value.trim(),
    body: bodyInput.value.trim(),
    dueAt: startAt,
    startAt,
    repeat: repeatInput.value,
    sourceLabel: sourceInput.value.trim(),
    enabled: true
  };
  if (kind === "timeBlock") {
    payload.endAt = isoFromLocalInput(endInput.value);
  }
  return payload;
}

function renderSettings(nextSettings) {
  settings = { ...settings, ...(nextSettings || {}) };
  const scale = Number.isFinite(Number(settings.mascotScale)) ? Number(settings.mascotScale) : 1;
  pausedInput.checked = Boolean(settings.paused);
  visibleInput.checked = settings.mascotVisible !== false;
  pinnedBarInput.checked = Boolean(settings.notificationBarPinned);
  mascotScaleInput.value = String(Math.round(scale * 100));
  mascotScaleValue.textContent = `${Math.round(scale * 100)}%`;
  autoLaunchInput.checked = Boolean(settings.autoLaunch);
  pauseStatusText.textContent = settings.paused ? "已暂停" : "运行中";
}

function renderAiConfig(nextConfig = {}) {
  aiConfig = { ...aiConfig, ...(nextConfig || {}) };
  aiBaseUrlInput.value = aiConfig.baseUrl || "";
  aiModelInput.value = aiConfig.model || "";
  aiChatPathInput.value = aiConfig.chatPath || "/v1/chat/completions";
  aiEnabledInput.checked = Boolean(aiConfig.enabled);
  activityTrackingInput.checked = Boolean(aiConfig.activityTracking);
  aiApiKeyInput.value = "";
  aiApiKeyInput.placeholder = aiConfig.hasApiKey ? "已保存，留空则不修改" : "粘贴你的 LLM API Key";
  aiStatus.textContent = aiConfig.enabled && aiConfig.hasApiKey ? "已配置" : "未配置";
  aiStatus.classList.toggle("ready", Boolean(aiConfig.enabled && aiConfig.hasApiKey));
}

function selectedSummaryTemplate() {
  return summaryTemplates.find((template) => template.id === summaryTemplateSelect.value) || summaryTemplates[0];
}

function renderSummaryTemplates(nextTemplates = []) {
  summaryTemplates = Array.isArray(nextTemplates) ? nextTemplates : [];
  const previousValue = summaryTemplateSelect.value || "default";
  summaryTemplateSelect.innerHTML = [
    ...summaryTemplates.map((template) => `
      <option value="${escapeHtml(template.id)}">${template.builtIn ? "内置：" : ""}${escapeHtml(template.name)}</option>
    `),
    '<option value="__new__">+ 新建自定义模板...</option>'
  ].join("");
  const stillExists = summaryTemplates.some((template) => template.id === previousValue);
  summaryTemplateSelect.value = stillExists ? previousValue : "default";
  updateTemplateButtons();
}

function updateTemplateButtons() {
  const template = selectedSummaryTemplate();
  const isBuiltIn = Boolean(template?.builtIn);
  const editorOpen = !summaryTemplateForm.hidden;
  editSummaryTemplateBtn.textContent = editorOpen ? "收起" : (isBuiltIn ? "查看" : "编辑");
  deleteSummaryTemplateBtn.hidden = !editorOpen || isBuiltIn || !editingTemplateId;
}

function openSummaryTemplateEditor(template = null) {
  const target = template || selectedSummaryTemplate();
  editingTemplateId = target?.builtIn ? "" : (target?.id || "");
  summaryTemplateNameInput.value = target?.name || "";
  summaryTemplateBodyInput.value = target?.body || "";
  summaryTemplateNameInput.disabled = Boolean(target?.builtIn);
  summaryTemplateBodyInput.disabled = Boolean(target?.builtIn);
  saveSummaryTemplateBtn.hidden = Boolean(target?.builtIn);
  deleteSummaryTemplateBtn.hidden = Boolean(target?.builtIn || !editingTemplateId);
  summaryTemplateForm.hidden = false;
  updateTemplateButtons();
  if (target?.builtIn) summaryTemplateBodyInput.focus();
  else summaryTemplateNameInput.focus();
}

function closeSummaryTemplateEditor() {
  editingTemplateId = "";
  summaryTemplateNameInput.disabled = false;
  summaryTemplateBodyInput.disabled = false;
  saveSummaryTemplateBtn.hidden = false;
  deleteSummaryTemplateBtn.hidden = true;
  summaryTemplateForm.hidden = true;
  updateTemplateButtons();
}

function formatHistoryDate(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "未知时间";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function renderSummaryHistory(nextHistory = [], preferredId = "") {
  summaryHistory = Array.isArray(nextHistory) ? nextHistory : [];
  const previousValue = preferredId || summaryHistorySelect.value || "";
  if (!summaryHistory.length) {
    summaryHistorySelect.innerHTML = '<option value="">暂无历史复盘</option>';
    summaryHistorySelect.disabled = true;
    openSummaryHistoryBtn.disabled = true;
    return;
  }
  summaryHistorySelect.disabled = false;
  openSummaryHistoryBtn.disabled = false;
  summaryHistorySelect.innerHTML = summaryHistory.map((entry) => {
    const marker = entry.fromModel ? "AI" : "本地";
    const label = `${formatHistoryDate(entry.createdAt)} · ${entry.range?.label || entry.title} · ${marker}`;
    return `<option value="${escapeHtml(entry.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  const stillExists = summaryHistory.some((entry) => entry.id === previousValue);
  summaryHistorySelect.value = stillExists ? previousValue : summaryHistory[0].id;
}

async function loadSummaryHistory(preferredId = "") {
  renderSummaryHistory(await window.xiaoli.invoke("summaryHistory:list"), preferredId);
}

function renderJustNowHistory(nextHistory = [], preferredId = "") {
  justNowHistory = Array.isArray(nextHistory) ? nextHistory : [];
  const previousValue = preferredId || justNowHistorySelect.value || "";
  if (!justNowHistory.length) {
    justNowHistorySelect.innerHTML = '<option value="">暂无历史记录</option>';
    justNowHistorySelect.disabled = true;
    openJustNowHistoryBtn.disabled = true;
    return;
  }
  justNowHistorySelect.disabled = false;
  openJustNowHistoryBtn.disabled = false;
  justNowHistorySelect.innerHTML = justNowHistory.map((entry) => {
    const marker = entry.status === "transcribed" ? "待复盘" : (entry.fromModel ? "AI" : "本地");
    const label = `${formatHistoryDate(entry.createdAt)} · ${entry.title || "刚刚发生了啥"} · ${marker}`;
    return `<option value="${escapeHtml(entry.id)}">${escapeHtml(label)}</option>`;
  }).join("");
  const stillExists = justNowHistory.some((entry) => entry.id === previousValue);
  justNowHistorySelect.value = stillExists ? previousValue : justNowHistory[0].id;
}

async function loadJustNowHistory(preferredId = "") {
  renderJustNowHistory(await window.xiaoli.invoke("justNowHistory:list"), preferredId);
}

async function openJustNowHistory(id = justNowHistorySelect.value) {
  if (!id) {
    toast("暂无刚刚发生了啥记录");
    return;
  }
  const entry = await window.xiaoli.invoke("justNowHistory:get", id);
  if (!entry) {
    toast("找不到这条记录");
    await loadJustNowHistory();
    return;
  }
  activeJustNowId = entry.id || "";
  setSummaryOutput({ ...entry, html: entry.html }, justNowOutput);
  justNowTranscriptInput.value = entry.editedTranscript || entry.transcript || "";
  justNowHistorySelect.value = entry.id;
  summarizeJustNowTextBtn.textContent = entry.status === "transcribed" ? "生成复盘" : "重新生成复盘";
}

function reminderDueMs(reminder) {
  const dueMs = new Date(reminder.startAt || reminder.dueAt).getTime();
  return Number.isFinite(dueMs) ? dueMs : Number.MAX_SAFE_INTEGER;
}

function sortedForDisplay(items) {
  return [...items].sort((left, right) => {
    if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
    return reminderDueMs(left) - reminderDueMs(right) || left.title.localeCompare(right.title, "zh-CN");
  });
}

function matchesSearch(reminder) {
  if (!searchText) return true;
  const haystack = [reminder.title, reminder.body, reminder.sourceLabel, repeatLabels[reminder.repeat], isTimeBlock(reminder) ? "时间块" : "单点提醒"]
    .join(" ")
    .toLocaleLowerCase("zh-CN");
  return haystack.includes(searchText);
}

function matchesFilter(reminder) {
  if (activeSource && (reminder.sourceLabel || "无标签") !== activeSource) return false;
  const due = new Date(reminder.startAt || reminder.dueAt);
  const end = new Date(reminder.endAt);
  if (activeFilter === "today") {
    return reminder.enabled && (isSameDay(due) || (isTimeBlock(reminder) && Number.isFinite(end.getTime()) && isSameDay(end)));
  }
  if (activeFilter === "scheduled") return reminder.enabled && reminderDueMs(reminder) >= startOfDay().getTime();
  if (activeFilter === "disabled") return !reminder.enabled;
  return true;
}

function filteredReminders() {
  return sortedForDisplay(reminders.filter((reminder) => matchesFilter(reminder) && matchesSearch(reminder)));
}

function countBy(predicate) {
  return reminders.filter(predicate).length;
}

function renderNavigationCounts() {
  document.querySelector("#todayCount").textContent = String(countBy((item) => {
    const start = new Date(item.startAt || item.dueAt);
    const end = new Date(item.endAt);
    return item.enabled && (isSameDay(start) || (isTimeBlock(item) && Number.isFinite(end.getTime()) && isSameDay(end)));
  }));
  document.querySelector("#scheduledCount").textContent = String(countBy((item) => item.enabled && reminderDueMs(item) >= startOfDay().getTime()));
  document.querySelector("#allCount").textContent = String(reminders.length);
  document.querySelector("#disabledCount").textContent = String(countBy((item) => !item.enabled));

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", !activeSource && button.dataset.filter === activeFilter);
  });
}

function renderSourceList() {
  const counts = new Map();
  for (const reminder of reminders) {
    const label = reminder.sourceLabel || "无标签";
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const sources = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], "zh-CN"));
  if (!sources.length) {
    sourceList.innerHTML = '<p class="source-empty">暂无来源标签</p>';
    return;
  }
  sourceList.innerHTML = sources.map(([source, count]) => `
    <button class="source-item ${activeSource === source ? "active" : ""}" data-source="${escapeHtml(source)}" type="button">
      <span class="source-dot"></span>
      <span>${escapeHtml(source)}</span>
      <strong>${count}</strong>
    </button>
  `).join("");
}

function renderListHeader(visibleReminders) {
  const title = activeSource ? activeSource : filterLabels[activeFilter] || "全部";
  listEyebrow.textContent = activeSource ? "来源标签" : "智能列表";
  listTitle.textContent = title;
  reminderCount.textContent = String(visibleReminders.length);
  listSubtitle.textContent = visibleReminders.length === 1 ? "条提醒" : "条提醒";
  filterHint.textContent = searchText ? `搜索：“${searchInput.value.trim()}”` : "按时间排序";
}

function renderNextPreview() {
  const upcoming = sortedForDisplay(reminders)
    .filter((reminder) => reminder.enabled && reminderDueMs(reminder) >= Date.now())[0];
  if (!upcoming) {
    nextReminderPreview.textContent = "暂无待提醒";
    return;
  }
  nextReminderPreview.textContent = `${formatReminderSchedule(upcoming)} · ${upcoming.title}`;
}

function emptyMessage() {
  if (searchText) return "没有匹配的提醒。";
  if (activeSource) return "这个来源下还没有提醒。";
  if (activeFilter === "today") return "今天没有待提醒事项。";
  if (activeFilter === "disabled") return "没有已停用提醒。";
  return "还没有提醒。点击“新建提醒”开始。";
}

function renderReminderRows(visibleReminders) {
  if (!visibleReminders.length) {
    reminderList.innerHTML = `<p class="empty">${escapeHtml(emptyMessage())}</p>`;
    return;
  }
  reminderList.innerHTML = visibleReminders.map((reminder) => {
    const body = reminder.body ? `<span class="reminder-body">${escapeHtml(reminder.body)}</span>` : "";
    const source = reminder.sourceLabel ? `<span class="pill source">${escapeHtml(reminder.sourceLabel)}</span>` : "";
    const repeat = reminder.repeat !== "none" ? `<span class="pill repeat">${repeatLabels[reminder.repeat] || reminder.repeat}</span>` : "";
    const snooze = reminder.snoozeCount ? `<span class="pill snooze">稍后 ${reminder.snoozeCount}</span>` : "";
    const kindPill = isTimeBlock(reminder) ? '<span class="pill block-kind">时间块</span>' : '<span class="pill instant-kind">单点</span>';
    const progress = timeBlockProgress(reminder);
    const progressPill = progress === null ? "" : `<span class="pill block-progress">进行中 ${Math.round(progress * 100)}%</span>`;
    const progressStyle = progress === null ? "" : ` style="--row-progress:${progress.toFixed(3)}"`;
    const selected = reminder.id === editingId ? "selected" : "";
    const disabled = reminder.enabled ? "" : "disabled";
    const toggleLabel = reminder.enabled ? "停用提醒" : "启用提醒";
    return `
      <article class="reminder-row ${isTimeBlock(reminder) ? "time-block-row" : "instant-row"} ${selected} ${disabled}" data-id="${reminder.id}"${progressStyle}>
        <button class="check-toggle" data-action="toggle" type="button" title="${toggleLabel}" aria-label="${toggleLabel}"></button>
        <button class="reminder-main" data-action="edit" type="button">
          <span class="reminder-schedule ${dueClass(reminder)}">${escapeHtml(formatReminderSchedule(reminder))}</span>
          <span class="reminder-title">${escapeHtml(reminder.title)}</span>
          ${body}
          <span class="reminder-meta">
            ${kindPill}
            ${repeat}
            ${progressPill}
            ${snooze}
            ${source}
          </span>
        </button>
        <div class="reminder-actions">
          <button type="button" data-action="edit">编辑</button>
          <button class="danger" type="button" data-action="delete">删除</button>
        </div>
      </article>
    `;
  }).join("");
}

function renderReminders(nextReminders) {
  reminders = Array.isArray(nextReminders) ? nextReminders : [];
  const visibleReminders = filteredReminders();
  renderNavigationCounts();
  renderSourceList();
  renderListHeader(visibleReminders);
  renderNextPreview();
  renderReminderRows(visibleReminders);
}

async function updateSetting(patch) {
  const next = await window.xiaoli.invoke("settings:update", patch);
  renderSettings(next);
}

document.querySelectorAll("[data-filter]").forEach((button) => {
  button.addEventListener("click", () => {
    activeFilter = button.dataset.filter || "all";
    activeSource = "";
    renderReminders(reminders);
  });
});

sourceList.addEventListener("click", (event) => {
  const button = event.target.closest(".source-item");
  if (!button) return;
  activeSource = button.dataset.source || "";
  activeFilter = "all";
  renderReminders(reminders);
});

searchInput.addEventListener("input", () => {
  searchText = searchInput.value.trim().toLocaleLowerCase("zh-CN");
  renderReminders(reminders);
});

reminderKindInputs.forEach((input) => {
  input.addEventListener("change", () => setReminderKind(input.value));
});

dueInput.addEventListener("change", () => {
  if (reminderKind() !== "timeBlock") return;
  const start = new Date(dueInput.value);
  const end = new Date(endInput.value);
  if (!Number.isFinite(start.getTime())) return;
  if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) {
    endInput.value = localInputValue(defaultEndDate(start));
  }
});

newReminderBtn.addEventListener("click", resetForm);
focusMascotSettingsBtn.addEventListener("click", () => setInspectorMode("mascot"));
focusAiBtn.addEventListener("click", () => {
  setInspectorMode("ai");
  aiPromptInput.focus();
});
focusJustNowBtn.addEventListener("click", () => {
  setInspectorMode("justNow");
  justNowTranscriptInput.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    saveReminderBtn.disabled = true;
    const payload = reminderPayload();
    if (editingId) {
      await window.xiaoli.invoke("reminders:update", payload);
      toast("提醒已更新");
    } else {
      await window.xiaoli.invoke("reminders:create", payload);
      toast("提醒已保存");
    }
    resetForm();
  } catch (error) {
    toast(error?.message || "保存失败");
  } finally {
    saveReminderBtn.disabled = false;
  }
});

resetFormBtn.addEventListener("click", resetForm);

reminderList.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  const item = event.target.closest(".reminder-row");
  if (!button || !item) return;
  const reminder = reminders.find((entry) => entry.id === item.dataset.id);
  if (!reminder) return;
  const action = button.dataset.action;
  try {
    if (action === "edit") {
      fillForm(reminder);
      return;
    }
    if (action === "toggle") {
      await window.xiaoli.invoke("reminders:update", {
        ...reminder,
        enabled: !reminder.enabled
      });
      toast(reminder.enabled ? "提醒已停用" : "提醒已启用");
      return;
    }
    if (action === "delete") {
      await window.xiaoli.invoke("reminders:delete", reminder.id);
      if (editingId === reminder.id) resetForm();
      toast("提醒已删除");
    }
  } catch (error) {
    toast(error?.message || "操作失败");
  }
});

pausedInput.addEventListener("change", () => {
  updateSetting({ paused: pausedInput.checked }).catch((error) => toast(error?.message || "设置失败"));
});

visibleInput.addEventListener("change", () => {
  updateSetting({ mascotVisible: visibleInput.checked }).catch((error) => toast(error?.message || "设置失败"));
});

pinnedBarInput.addEventListener("change", () => {
  updateSetting({ notificationBarPinned: pinnedBarInput.checked }).catch((error) => toast(error?.message || "设置失败"));
});

mascotScaleInput.addEventListener("input", () => {
  mascotScaleValue.textContent = `${mascotScaleInput.value}%`;
});

mascotScaleInput.addEventListener("change", () => {
  updateSetting({ mascotScale: Number(mascotScaleInput.value) / 100 }).catch((error) => toast(error?.message || "设置失败"));
});

autoLaunchInput.addEventListener("change", () => {
  updateSetting({ autoLaunch: autoLaunchInput.checked }).catch((error) => toast(error?.message || "设置失败"));
});

aiConfigForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    saveAiConfigBtn.disabled = true;
    const payload = {
      enabled: aiEnabledInput.checked,
      activityTracking: activityTrackingInput.checked,
      baseUrl: aiBaseUrlInput.value.trim(),
      model: aiModelInput.value.trim(),
      chatPath: aiChatPathInput.value.trim()
    };
    if (aiApiKeyInput.value.trim()) payload.apiKey = aiApiKeyInput.value.trim();
    const next = await window.xiaoli.invoke("ai:updateConfig", payload);
    renderAiConfig(next);
    toast("AI 配置已保存");
  } catch (error) {
    toast(error?.message || "AI 配置保存失败");
  } finally {
    saveAiConfigBtn.disabled = false;
  }
});

testAiBtn.addEventListener("click", async () => {
  try {
    testAiBtn.disabled = true;
    const result = await window.xiaoli.invoke("ai:test");
    toast(result?.message || "LLM 连接正常");
  } catch (error) {
    toast(error?.message || "LLM 测试失败");
  } finally {
    testAiBtn.disabled = false;
  }
});

function sanitizeSummaryHtml(html) {
  const allowedTags = new Set(["ARTICLE", "SECTION", "H3", "P", "UL", "LI", "STRONG", "SPAN"]);
  const template = document.createElement("template");
  template.innerHTML = String(html || "");

  function clean(node) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META"].includes(node.tagName)) {
        node.remove();
        return;
      }
      if (!allowedTags.has(node.tagName)) {
        const text = document.createTextNode(node.textContent || "");
        node.replaceWith(text);
        return;
      }
      for (const attr of Array.from(node.attributes)) {
        if (attr.name !== "class") {
          node.removeAttribute(attr.name);
          continue;
        }
        const allowedClasses = String(attr.value || "")
          .split(/\s+/)
          .filter((item) => item === "review-card")
          .join(" ");
        if (allowedClasses) node.setAttribute("class", allowedClasses);
        else node.removeAttribute("class");
      }
    }
    Array.from(node.childNodes).forEach(clean);
  }

  Array.from(template.content.childNodes).forEach(clean);
  return template.innerHTML.trim();
}

function setSummaryOutput(result = {}, target = aiSummaryOutput) {
  if (target === justNowOutput && result.status === "transcribed") {
    target.textContent = [
      "转写草稿已保存。",
      "请确认或编辑上方文字，然后点击“生成复盘”。",
      result.warning ? `提示：${result.warning}` : ""
    ].filter(Boolean).join("\n");
    return;
  }
  const html = sanitizeSummaryHtml(result.html || "");
  if (html) {
    target.innerHTML = html;
    return;
  }
  target.textContent = [
    result.warning ? `提示：${result.warning}\n` : "",
    result.summary || "没有生成内容。"
  ].filter(Boolean).join("\n");
}

function summaryPayload() {
  const payload = {
    range: selectedSummaryRange,
    templateId: summaryTemplateSelect.value || "default",
    prompt: aiPromptInput.value.trim()
  };
  if (selectedSummaryRange === "custom") {
    payload.startDate = summaryStartInput.value;
    payload.endDate = summaryEndInput.value;
  }
  return payload;
}

document.querySelectorAll("[data-summary-choice]").forEach((button) => {
  button.addEventListener("click", () => {
    selectedSummaryRange = button.dataset.summaryChoice || "today";
    document.querySelectorAll("[data-summary-choice]").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    customRangeFields.hidden = selectedSummaryRange !== "custom";
  });
});

summaryTemplateSelect.addEventListener("change", () => {
  if (summaryTemplateSelect.value === "__new__") {
    summaryTemplateSelect.value = selectedSummaryTemplate()?.id || "default";
    openSummaryTemplateEditor({
      id: "",
      name: "",
      body: "# 自定义复盘模板\n\n- ",
      builtIn: false
    });
    return;
  }
  closeSummaryTemplateEditor();
  updateTemplateButtons();
});

editSummaryTemplateBtn.addEventListener("click", () => {
  if (!summaryTemplateForm.hidden) {
    closeSummaryTemplateEditor();
    return;
  }
  openSummaryTemplateEditor(selectedSummaryTemplate());
});

summaryTemplateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    saveSummaryTemplateBtn.disabled = true;
    const saved = await window.xiaoli.invoke("summaryTemplates:save", {
      id: editingTemplateId || undefined,
      name: summaryTemplateNameInput.value.trim(),
      body: summaryTemplateBodyInput.value.trim()
    });
    renderSummaryTemplates(await window.xiaoli.invoke("summaryTemplates:list"));
    summaryTemplateSelect.value = saved.id;
    closeSummaryTemplateEditor();
    toast("复盘模板已保存");
  } catch (error) {
    toast(error?.message || "模板保存失败");
  } finally {
    saveSummaryTemplateBtn.disabled = false;
  }
});

deleteSummaryTemplateBtn.addEventListener("click", async () => {
  if (!editingTemplateId) return;
  try {
    await window.xiaoli.invoke("summaryTemplates:delete", editingTemplateId);
    renderSummaryTemplates(await window.xiaoli.invoke("summaryTemplates:list"));
    summaryTemplateSelect.value = "default";
    closeSummaryTemplateEditor();
    toast("复盘模板已删除");
  } catch (error) {
    toast(error?.message || "模板删除失败");
  }
});

generateSummaryBtn.addEventListener("click", async () => {
  try {
    generateSummaryBtn.disabled = true;
    generateSummaryBtn.textContent = "生成中...";
    aiSummaryOutput.textContent = "AI小力正在整理本地活动...";
    const result = await window.xiaoli.invoke("ai:summarize", summaryPayload());
    setSummaryOutput(result);
    await loadSummaryHistory(result?.historyId || "");
    toast(result?.fromModel ? "智能复盘已生成" : "已生成本地统计摘要");
  } catch (error) {
    aiSummaryOutput.textContent = error?.message || "总结失败";
    toast(error?.message || "总结失败");
  } finally {
    generateSummaryBtn.disabled = false;
    generateSummaryBtn.textContent = "生成智能复盘";
  }
});

openSummaryHistoryBtn.addEventListener("click", async () => {
  const id = summaryHistorySelect.value;
  if (!id) {
    toast("暂无历史复盘");
    return;
  }
  try {
    openSummaryHistoryBtn.disabled = true;
    const entry = await window.xiaoli.invoke("summaryHistory:get", id);
    if (!entry) {
      toast("找不到这条历史复盘");
      await loadSummaryHistory();
      return;
    }
    setSummaryOutput(entry);
    if (entry.template?.id && summaryTemplates.some((template) => template.id === entry.template.id)) {
      summaryTemplateSelect.value = entry.template.id;
      closeSummaryTemplateEditor();
    }
    toast("已打开历史复盘");
  } catch (error) {
    toast(error?.message || "打开历史复盘失败");
  } finally {
    openSummaryHistoryBtn.disabled = !summaryHistory.length;
  }
});

summarizeJustNowTextBtn.addEventListener("click", async () => {
  const transcript = justNowTranscriptInput.value.trim();
  if (!transcript) {
    toast("请先输入或录制一段内容");
    return;
  }
  try {
    summarizeJustNowTextBtn.disabled = true;
    summarizeJustNowTextBtn.textContent = "生成中...";
    justNowOutput.textContent = "AI小力正在根据确认后的转写生成复盘...";
    const result = await window.xiaoli.invoke("justNow:summarize", {
      id: activeJustNowId,
      transcript
    });
    setSummaryOutput(result, justNowOutput);
    activeJustNowId = result.id || activeJustNowId;
    await loadJustNowHistory(result.id);
    toast(result?.fromModel ? "刚刚发生了啥已生成复盘" : "已保存本地复盘");
  } catch (error) {
    justNowOutput.textContent = error?.message || "整理失败";
    toast(error?.message || "整理失败");
  } finally {
    summarizeJustNowTextBtn.disabled = false;
    summarizeJustNowTextBtn.textContent = "生成复盘";
  }
});

saveJustNowTemplateBtn.addEventListener("click", async () => {
  try {
    saveJustNowTemplateBtn.disabled = true;
    await window.xiaoli.invoke("justNowTemplate:update", {
      body: justNowTemplateInput.value.trim()
    });
    toast("刚刚发生了啥模板已保存");
  } catch (error) {
    toast(error?.message || "模板保存失败");
  } finally {
    saveJustNowTemplateBtn.disabled = false;
  }
});

openJustNowHistoryBtn.addEventListener("click", async () => {
  try {
    openJustNowHistoryBtn.disabled = true;
    await openJustNowHistory();
    toast("已打开历史记录");
  } catch (error) {
    toast(error?.message || "打开历史记录失败");
  } finally {
    openJustNowHistoryBtn.disabled = !justNowHistory.length;
  }
});

testAnimationBtn.addEventListener("click", async () => {
  await window.xiaoli.invoke("mascot:triggerAnimation", {
    title: "动效测试",
    body: "小力会在真实提醒到点时这样跳出来。",
    sourceLabel: "测试"
  });
});

window.xiaoli.on("settings:changed", renderSettings);
window.xiaoli.on("reminders:changed", renderReminders);
window.xiaoli.on("settings:focusCreate", () => {
  resetForm();
});
window.xiaoli.on("settings:focusAi", () => {
  setInspectorMode("ai");
  aiPromptInput.focus();
});
window.xiaoli.on("settings:focusJustNow", async (payload = {}) => {
  setInspectorMode("justNow");
  await loadJustNowHistory(payload.historyId || "");
  if (payload.historyId) {
    await openJustNowHistory(payload.historyId);
  }
  justNowTranscriptInput.focus();
});

async function init() {
  setInspectorMode("reminder");
  summaryStartInput.value = localDateValue();
  summaryEndInput.value = localDateValue();
  resetForm();
  renderSettings(await window.xiaoli.invoke("settings:get"));
  renderAiConfig(await window.xiaoli.invoke("ai:getConfig"));
  renderSummaryTemplates(await window.xiaoli.invoke("summaryTemplates:list"));
  const justNowTemplate = await window.xiaoli.invoke("justNowTemplate:get");
  justNowTemplateInput.value = justNowTemplate?.body || "";
  await loadSummaryHistory();
  await loadJustNowHistory();
  renderReminders(await window.xiaoli.invoke("reminders:list"));
}

init().catch((error) => toast(error?.message || "加载失败"));
