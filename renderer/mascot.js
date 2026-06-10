const shell = document.querySelector("#mascotShell");
const bubble = document.querySelector("#bubble");
const bubbleSource = document.querySelector("#bubbleSource");
const bubbleTitle = document.querySelector("#bubbleTitle");
const bubbleBody = document.querySelector("#bubbleBody");
const bubbleSnoozeBtn = document.querySelector("#bubbleSnoozeBtn");
const bubbleActions = document.querySelector(".bubble-actions");
const openSettingsBtn = document.querySelector("#openSettingsBtn");
const justNowBtn = document.querySelector("#justNowBtn");
const pauseBtn = document.querySelector("#pauseBtn");
const stars = document.querySelector("#stars");
const mascotLayers = document.querySelector("#mascotLayers");
const mascotHitArea = document.querySelector("#mascotHitArea");
const quickActions = document.querySelector(".quick-actions");
const resizeHandle = document.querySelector("#resizeHandle");
const mascotImages = Array.from(document.querySelectorAll(".mascot-img, .mascot-color-img"));

const LISTENING_FALLBACK_STOP_MS = 4000;
const MIN_MASCOT_SCALE = 0.7;
const MAX_MASCOT_SCALE = 1.45;

let settings = { paused: false };
let bubbleIsReminder = false;
let activeReminder = null;
let mascotFrames = [];
let listeningFrames = [];
let reminderFrameTimer = null;
let reminderFrameIndex = 0;
let reminderFrameDirection = 1;
let reminderFrameHoldUntil = 0;
let listeningFrameTimer = null;
let listeningStopTimer = null;
let listeningFrameIndex = 0;
let listeningFrameDirection = 1;
let mascotPointer = null;
let dragPreviewFrame = 0;
let pendingDragPoint = null;
let resizePointer = null;
let resizePreviewFrame = 0;
let mousePassthrough = null;
let bubbleInteractive = null;
let activeTimeBlock = null;
let timeBlockTimer = null;
let justNowRecording = false;
let justNowStartedAt = 0;
let statusBubbleTimer = null;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function compactText(value, maxLength) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function isVisiblePixel(data, index) {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  return red > 18 || green > 18 || blue > 18;
}

function isBackgroundPixel(data, index) {
  const red = data[index];
  const green = data[index + 1];
  const blue = data[index + 2];
  const alpha = data[index + 3];
  if (alpha === 0) return true;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  return max < 24 && max - min < 8;
}

function transparentEdgeBackground(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  const seen = new Uint8Array(width * height);
  const queue = [];

  function push(x, y) {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const point = y * width + x;
    if (seen[point]) return;
    const index = point * 4;
    if (!isBackgroundPixel(data, index)) return;
    seen[point] = 1;
    queue.push(point);
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  while (queue.length) {
    const point = queue.pop();
    const x = point % width;
    const y = Math.floor(point / width);
    const index = point * 4;
    data[index + 3] = 0;
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  context.putImageData(image, 0, 0);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载小力图片：${src}`));
    image.src = src;
  });
}

function frameCanvasFromImage(image) {
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0);
  transparentEdgeBackground(canvas);
  return canvas;
}

function visibleBounds(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const { data, width, height } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] === 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }

  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width, height };
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

function unionFrameBounds(boundsList, canvas) {
  const union = boundsList.reduce((result, bounds) => ({
    minX: Math.min(result.minX, bounds.x),
    minY: Math.min(result.minY, bounds.y),
    maxX: Math.max(result.maxX, bounds.x + bounds.width),
    maxY: Math.max(result.maxY, bounds.y + bounds.height)
  }), {
    minX: canvas.width,
    minY: canvas.height,
    maxX: 0,
    maxY: 0
  });
  const padding = 18;
  const x = clamp(union.minX - padding, 0, canvas.width - 1);
  const y = clamp(union.minY - padding, 0, canvas.height - 1);
  const maxX = clamp(union.maxX + padding, x + 1, canvas.width);
  const maxY = clamp(union.maxY + padding, y + 1, canvas.height);
  return {
    x,
    y,
    width: maxX - x,
    height: maxY - y
  };
}

function cropFrame(canvas, crop) {
  const output = document.createElement("canvas");
  output.width = crop.width;
  output.height = crop.height;
  const context = output.getContext("2d", { willReadFrequently: true });
  context.drawImage(canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
  return output.toDataURL("image/png");
}

function setMascotFrame(src) {
  if (!src) return;
  mascotImages.forEach((node) => {
    node.src = src;
  });
}

function mascotScale() {
  const scale = Number(settings.mascotScale);
  return Number.isFinite(scale) ? clamp(scale, MIN_MASCOT_SCALE, MAX_MASCOT_SCALE) : 1;
}

function previewMascotScale(scale) {
  const nextScale = clamp(Number(scale) || 1, MIN_MASCOT_SCALE, MAX_MASCOT_SCALE);
  cancelAnimationFrame(resizePreviewFrame);
  resizePreviewFrame = requestAnimationFrame(() => {
    shell.style.setProperty("--mascot-scale", String(nextScale));
  });
}

function queueMascotDrag(point) {
  pendingDragPoint = point;
  if (dragPreviewFrame) return;
  dragPreviewFrame = requestAnimationFrame(() => {
    dragPreviewFrame = 0;
    if (!pendingDragPoint) return;
    window.xiaoli.send("mascot:dragMove", pendingDragPoint);
    pendingDragPoint = null;
  });
}

function rectContains(rect, x, y, padding = 0) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  return x >= rect.left - padding
    && x <= rect.right + padding
    && y >= rect.top - padding
    && y <= rect.bottom + padding;
}

function elementVisible(element) {
  if (!element || element.hidden) return false;
  const styles = window.getComputedStyle(element);
  return styles.display !== "none" && styles.visibility !== "hidden" && styles.pointerEvents !== "none";
}

function pointInMascotVisualShape(x, y) {
  const rect = mascotLayers.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const localX = (x - rect.left) / rect.width;
  const localY = (y - rect.top) / rect.height;
  if (localX < 0 || localX > 1 || localY < 0 || localY > 1) return false;
  return [
    { left: 0.07, top: 0.01, right: 0.93, bottom: 0.42 },
    { left: 0, top: 0.35, right: 1, bottom: 0.92 },
    { left: 0.17, top: 0.86, right: 0.83, bottom: 1 }
  ].some((zone) => (
    localX >= zone.left
      && localX <= zone.right
      && localY >= zone.top
      && localY <= zone.bottom
  ));
}

function isInteractivePoint(event) {
  const { clientX, clientY } = event;
  const buttonTarget = event.target?.closest?.("button");
  if (buttonTarget && buttonTarget !== mascotHitArea) return true;
  if (bubbleInteractive && elementVisible(bubble) && rectContains(bubble.getBoundingClientRect(), clientX, clientY, 8)) return true;
  if (elementVisible(quickActions) && rectContains(quickActions.getBoundingClientRect(), clientX, clientY, 8)) return true;
  if (elementVisible(resizeHandle) && rectContains(resizeHandle.getBoundingClientRect(), clientX, clientY, 12)) return true;
  return pointInMascotVisualShape(clientX, clientY);
}

function setMousePassthrough(ignore) {
  const next = Boolean(ignore);
  if (mousePassthrough === next || !window.xiaoli?.send) return;
  mousePassthrough = next;
  window.xiaoli.send("mascot:setMousePassthrough", next);
}

function setBubbleInteractive(enabled) {
  const next = Boolean(enabled);
  if (bubbleInteractive === next || !window.xiaoli?.send) return;
  bubbleInteractive = next;
  window.xiaoli.send("mascot:setBubbleInteractive", next);
}

function syncMousePassthrough(event) {
  const interactive = isInteractivePoint(event);
  setMousePassthrough(!interactive);
  shell.classList.toggle("hover", interactive);
  return interactive;
}

async function loadFrameSet(sources) {
  const images = await Promise.all(sources.map(loadImage));
  const canvases = images.map(frameCanvasFromImage);
  const crop = unionFrameBounds(canvases.map(visibleBounds), canvases[0]);
  return canvases.map((canvas) => cropFrame(canvas, crop));
}

async function loadLegacyMascot() {
  const image = new Image();
  image.onload = () => {
    const canvas = frameCanvasFromImage(image);
    const source = cropFrame(canvas, visibleBounds(canvas));
    setMascotFrame(source);
  };
  image.src = "../assets/xiaoli-source.png";
}

async function loadMascot() {
  try {
    const sources = Array.from({ length: 14 }, (_item, index) => `../assets/xiaoli/${index + 1}.png`);
    mascotFrames = await loadFrameSet(sources);
    setMascotFrame(mascotFrames[0]);
  } catch (error) {
    console.error(error);
    loadLegacyMascot();
  }
  try {
    const listeningSources = Array.from({ length: 14 }, (_item, index) => `../assets/listening/00${index + 1}.png`);
    listeningFrames = await loadFrameSet(listeningSources);
  } catch (error) {
    console.error(error);
    listeningFrames = [];
  }
}

function startReminderFrames() {
  if (mascotFrames.length < 2) return;
  stopListeningFrames();
  clearInterval(reminderFrameTimer);
  reminderFrameIndex = 0;
  reminderFrameDirection = 1;
  reminderFrameHoldUntil = 0;
  setMascotFrame(mascotFrames[reminderFrameIndex]);
  reminderFrameTimer = setInterval(() => {
    if (!bubbleIsReminder) {
      stopReminderFrames();
      return;
    }
    if (Date.now() < reminderFrameHoldUntil) return;
    const wasReturning = reminderFrameDirection < 0;
    reminderFrameIndex += reminderFrameDirection;
    if (reminderFrameIndex >= mascotFrames.length - 1) {
      reminderFrameIndex = mascotFrames.length - 1;
      reminderFrameDirection = -1;
    } else if (reminderFrameIndex <= 0) {
      reminderFrameIndex = 0;
      reminderFrameDirection = 1;
      if (wasReturning) reminderFrameHoldUntil = Date.now() + 1000;
    }
    setMascotFrame(mascotFrames[reminderFrameIndex]);
  }, 72);
}

function stopReminderFrames() {
  clearInterval(reminderFrameTimer);
  reminderFrameTimer = null;
  reminderFrameIndex = 0;
  reminderFrameDirection = 1;
  reminderFrameHoldUntil = 0;
  if (mascotFrames[0]) setMascotFrame(mascotFrames[0]);
}

function startListeningFrames() {
  if (bubbleIsReminder || listeningFrames.length < 2) return;
  window.xiaoli?.send?.("activity:record", {
    type: "mascot.listen",
    title: "点击小力进入聆听态"
  });
  clearInterval(listeningFrameTimer);
  clearTimeout(listeningStopTimer);
  listeningFrameIndex = 0;
  listeningFrameDirection = 1;
  shell.classList.add("listening", "hover");
  setMascotFrame(listeningFrames[listeningFrameIndex]);
  listeningFrameTimer = setInterval(() => {
    if (bubbleIsReminder) {
      stopListeningFrames();
      return;
    }
    const wasReturning = listeningFrameDirection < 0;
    listeningFrameIndex += listeningFrameDirection;
    if (listeningFrameIndex >= listeningFrames.length - 1) {
      listeningFrameIndex = listeningFrames.length - 1;
      listeningFrameDirection = -1;
    } else if (listeningFrameIndex <= 0) {
      listeningFrameIndex = 0;
      listeningFrameDirection = 1;
      setMascotFrame(listeningFrames[listeningFrameIndex]);
      if (wasReturning) {
        stopListeningFrames();
        return;
      }
    }
    setMascotFrame(listeningFrames[listeningFrameIndex]);
  }, 72);
  listeningStopTimer = setTimeout(stopListeningFrames, LISTENING_FALLBACK_STOP_MS);
}

function stopListeningFrames() {
  clearInterval(listeningFrameTimer);
  clearTimeout(listeningStopTimer);
  listeningFrameTimer = null;
  listeningStopTimer = null;
  listeningFrameIndex = 0;
  listeningFrameDirection = 1;
  shell.classList.remove("listening", "dragging");
  if (!bubbleIsReminder && mascotFrames[0]) setMascotFrame(mascotFrames[0]);
}

function createStars() {
  const colors = ["#fff4a8", "#65d9ff", "#ff7cdd", "#ff9f42", "#ffffff"];
  for (let index = 0; index < 34; index += 1) {
    const star = document.createElement("i");
    const size = 3 + Math.round(Math.random() * 5);
    star.style.left = `${8 + Math.random() * 84}%`;
    star.style.top = `${8 + Math.random() * 84}%`;
    star.style.setProperty("--size", `${size}px`);
    star.style.setProperty("--color", colors[index % colors.length]);
    star.style.setProperty("--speed", `${1.7 + Math.random() * 2.5}s`);
    star.style.setProperty("--delay", `${Math.random() * -3}s`);
    stars.appendChild(star);
  }
}

function applySettings(nextSettings) {
  settings = { ...settings, ...(nextSettings || {}) };
  const scale = Number.isFinite(Number(settings.mascotScale)) ? Number(settings.mascotScale) : 1;
  shell.style.setProperty("--mascot-scale", String(scale));
  shell.classList.toggle("sleep", Boolean(settings.paused));
  shell.classList.toggle("pinned-bar", Boolean(settings.notificationBarPinned));
  pauseBtn.textContent = settings.paused ? "▶" : "Ⅱ";
  pauseBtn.title = settings.paused ? "恢复提醒" : "暂停提醒";
  pauseBtn.setAttribute("aria-label", pauseBtn.title);
  if (!bubbleIsReminder) renderIdleBubble();
}

function renderIdleBubble() {
  clearTimeout(statusBubbleTimer);
  bubbleIsReminder = false;
  activeReminder = null;
  setBubbleInteractive(false);
  stopReminderFrames();
  shell.classList.remove("reminding", "timeblock-start-reminder");
  bubble.classList.add("idle-bubble");
  bubbleSnoozeBtn.hidden = true;
  bubbleActions.hidden = true;
  bubble.removeAttribute("title");
  if (!settings.notificationBarPinned) {
    bubble.hidden = true;
    return;
  }
  if (activeTimeBlock?.active) {
    const percent = Math.round(Number(activeTimeBlock.progress || 0) * 100);
    bubbleSource.textContent = "任务进行中";
    bubbleTitle.textContent = compactText(`${activeTimeBlock.title || "时间块"} ${percent}%`, 12);
    bubbleBody.textContent = [activeTimeBlock.startAtLocal, activeTimeBlock.endAtLocal].filter(Boolean).join(" - ");
  } else {
    bubbleSource.textContent = settings.paused ? "小力休息中" : "小力在线";
    bubbleTitle.textContent = settings.paused ? "提醒已暂停" : "待命中";
    bubbleBody.textContent = settings.paused ? "恢复后继续提醒。" : "有事我会提醒你。";
  }
  bubble.hidden = false;
}

function renderStatusBubble(source, title, body = "", autoHideMs = 0) {
  if (bubbleIsReminder) return;
  clearTimeout(statusBubbleTimer);
  bubble.classList.add("idle-bubble");
  bubbleSnoozeBtn.hidden = true;
  bubbleActions.hidden = true;
  bubble.removeAttribute("title");
  bubbleSource.textContent = source;
  bubbleTitle.textContent = title;
  bubbleBody.textContent = body;
  bubble.hidden = false;
  if (autoHideMs > 0) {
    statusBubbleTimer = setTimeout(renderIdleBubble, autoHideMs);
  }
}

function showBubble(payload = {}) {
  bubbleIsReminder = true;
  activeReminder = payload;
  setBubbleInteractive(true);
  bubble.classList.remove("idle-bubble");
  const isTimeBlockStart = payload.kind === "timeBlock";
  const compactTitleLength = window.innerWidth <= 520 ? 14 : 20;
  const compactBodyLength = window.innerWidth <= 520 ? 18 : 28;
  bubbleSource.textContent = isTimeBlockStart
    ? "时间块开始"
    : (payload.sourceLabel ? `来自 ${payload.sourceLabel}` : "AI小力");
  bubbleTitle.textContent = compactText(payload.title || "提醒", compactTitleLength);
  bubbleBody.textContent = compactText(payload.body || (isTimeBlockStart ? "任务开始了。" : "时间到了。"), compactBodyLength);
  bubbleSnoozeBtn.hidden = isTimeBlockStart || !payload.id || payload.id === "test";
  bubbleActions.hidden = bubbleSnoozeBtn.hidden;
  bubble.title = "点击关闭提醒";
  bubble.hidden = false;
  shell.classList.toggle("timeblock-start-reminder", isTimeBlockStart);
  if (isTimeBlockStart) {
    shell.classList.remove("reminding");
    stopReminderFrames();
  } else {
    shell.classList.add("reminding");
    startReminderFrames();
  }
}

function triggerTaskRingDissolve() {
  shell.classList.remove("time-block-active");
  shell.style.setProperty("--task-progress", "1");
  shell.classList.add("time-block-ending");
  setTimeout(() => shell.classList.remove("time-block-ending"), 900);
}

function applyTimeBlockState(payload = {}) {
  const hadActiveTimeBlock = Boolean(activeTimeBlock);
  activeTimeBlock = payload?.active ? payload : null;
  clearInterval(timeBlockTimer);
  if (activeTimeBlock) {
    timeBlockTimer = setInterval(updateTimeBlockProgress, 10000);
  } else if (hadActiveTimeBlock) {
    triggerTaskRingDissolve();
    if (!bubbleIsReminder) renderIdleBubble();
    return;
  }
  updateTimeBlockProgress();
}

function updateTimeBlockProgress() {
  let progress = Math.min(Math.max(Number(activeTimeBlock?.progress || 0), 0), 1);
  let justFinished = false;
  if (activeTimeBlock?.startAt && activeTimeBlock?.endAt) {
    const startMs = new Date(activeTimeBlock.startAt).getTime();
    const endMs = new Date(activeTimeBlock.endAt).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      progress = Math.min(Math.max((Date.now() - startMs) / (endMs - startMs), 0), 1);
      activeTimeBlock.progress = progress;
      if (progress >= 1) {
        activeTimeBlock = null;
        justFinished = true;
        clearInterval(timeBlockTimer);
      }
    }
  }
  shell.classList.toggle("time-block-active", Boolean(activeTimeBlock));
  shell.style.setProperty("--task-progress", String(progress));
  if (justFinished) {
    triggerTaskRingDissolve();
  }
  if (!bubbleIsReminder) renderIdleBubble();
}

function bindPress(button, handler) {
  let lastRun = 0;
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const now = Date.now();
    if (now - lastRun < 240) return;
    lastRun = now;
    handler();
  };
  button.addEventListener("pointerup", run);
  button.addEventListener("click", run);
}

bindPress(openSettingsBtn, () => {
  window.xiaoli.invoke("settings:open");
});

async function startJustNowRecording() {
  if (justNowRecording || bubbleIsReminder) return;
  justNowStartedAt = Date.now();
  await window.xiaoli.invoke("justNow:recordStart");
  justNowRecording = true;
  shell.classList.add("just-now-recording", "hover");
  justNowBtn.textContent = "■";
  justNowBtn.title = "停止记录";
  justNowBtn.setAttribute("aria-label", "停止记录");
  renderStatusBubble("刚刚发生了啥", "正在记录", "再次点击右上角按钮结束。");
}

async function stopJustNowRecording() {
  if (!justNowRecording) return;
  justNowRecording = false;
  shell.classList.remove("just-now-recording");
  justNowBtn.textContent = "录";
  justNowBtn.title = "刚刚发生了啥";
  justNowBtn.setAttribute("aria-label", "刚刚发生了啥");
  renderStatusBubble("刚刚发生了啥", "转写中", "小力正在本机转写。");
  const result = await window.xiaoli.invoke("justNow:recordStop", {
    durationMs: Date.now() - justNowStartedAt
  });
  renderStatusBubble("刚刚发生了啥", "转写好了", "已保存草稿，等待确认。", 1800);
  await window.xiaoli.invoke("settings:openJustNow", { historyId: result.id });
}

bindPress(justNowBtn, async () => {
  try {
    if (justNowRecording) await stopJustNowRecording();
    else await startJustNowRecording();
  } catch (error) {
    justNowRecording = false;
    shell.classList.remove("just-now-recording");
    justNowBtn.textContent = "录";
    justNowBtn.title = "刚刚发生了啥";
    justNowBtn.setAttribute("aria-label", "刚刚发生了啥");
    renderStatusBubble("刚刚发生了啥", "记录失败", error?.message || "无法打开麦克风。", 3200);
  }
});

bindPress(pauseBtn, async () => {
  const next = await window.xiaoli.invoke("settings:update", { paused: !settings.paused });
  applySettings(next);
});

bindPress(bubbleSnoozeBtn, async () => {
  if (!activeReminder?.id) return;
  bubbleSnoozeBtn.disabled = true;
  try {
    await window.xiaoli.invoke("reminders:snooze", {
      id: activeReminder.id,
      minutes: 10
    });
    renderIdleBubble();
  } finally {
    bubbleSnoozeBtn.disabled = false;
  }
});

bubble.addEventListener("click", (event) => {
  if (!bubbleIsReminder || event.target?.closest?.("button")) return;
  event.preventDefault();
  event.stopPropagation();
  renderIdleBubble();
});

resizeHandle.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  setMousePassthrough(false);
  shell.classList.add("hover", "resizing");
  resizeHandle.setPointerCapture(event.pointerId);
  resizePointer = {
    pointerId: event.pointerId,
    startScreenX: Number.isFinite(event.screenX) ? event.screenX : event.clientX + window.screenX,
    startScreenY: Number.isFinite(event.screenY) ? event.screenY : event.clientY + window.screenY,
    startScale: mascotScale()
  };
  window.xiaoli.send("mascot:resizeStart", pointerScreenPoint(event));
});

resizeHandle.addEventListener("pointermove", (event) => {
  if (!resizePointer || resizePointer.pointerId !== event.pointerId) return;
  event.preventDefault();
  const point = pointerScreenPoint(event);
  const delta = Math.max(point.x - resizePointer.startScreenX, point.y - resizePointer.startScreenY);
  previewMascotScale(resizePointer.startScale + delta / 360);
  window.xiaoli.send("mascot:resizeMove", pointerScreenPoint(event));
});

function finishResizePointer(event) {
  if (!resizePointer || resizePointer.pointerId !== event.pointerId) return;
  resizePointer = null;
  shell.classList.remove("resizing");
  if (resizeHandle.hasPointerCapture(event.pointerId)) {
    resizeHandle.releasePointerCapture(event.pointerId);
  }
  window.xiaoli.send("mascot:resizeEnd");
}

resizeHandle.addEventListener("pointerup", finishResizePointer);
resizeHandle.addEventListener("pointercancel", finishResizePointer);

function pointerScreenPoint(event) {
  return {
    x: Number.isFinite(event.screenX) ? event.screenX : event.clientX + window.screenX,
    y: Number.isFinite(event.screenY) ? event.screenY : event.clientY + window.screenY
  };
}

mascotHitArea.addEventListener("pointerenter", (event) => {
  syncMousePassthrough(event);
  shell.classList.add("hover");
});

mascotHitArea.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  setMousePassthrough(false);
  shell.classList.add("hover");
  mascotHitArea.setPointerCapture(event.pointerId);
  const point = pointerScreenPoint(event);
  mascotPointer = {
    pointerId: event.pointerId,
    startClientX: event.clientX,
    startClientY: event.clientY,
    moved: false
  };
  window.xiaoli.send("mascot:dragStart", point);
});

mascotHitArea.addEventListener("pointermove", (event) => {
  syncMousePassthrough(event);
  if (!mascotPointer || mascotPointer.pointerId !== event.pointerId) return;
  const dx = event.clientX - mascotPointer.startClientX;
  const dy = event.clientY - mascotPointer.startClientY;
  if (Math.hypot(dx, dy) > 4) {
    mascotPointer.moved = true;
    shell.classList.add("dragging");
  }
  if (mascotPointer.moved) {
    event.preventDefault();
    queueMascotDrag(pointerScreenPoint(event));
  }
});

function finishMascotPointer(event) {
  if (!mascotPointer || mascotPointer.pointerId !== event.pointerId) return;
  const wasClick = !mascotPointer.moved;
  mascotPointer = null;
  cancelAnimationFrame(dragPreviewFrame);
  dragPreviewFrame = 0;
  if (pendingDragPoint) {
    window.xiaoli.send("mascot:dragMove", pendingDragPoint);
    pendingDragPoint = null;
  }
  shell.classList.remove("dragging");
  if (mascotHitArea.hasPointerCapture(event.pointerId)) {
    mascotHitArea.releasePointerCapture(event.pointerId);
  }
  window.xiaoli.send("mascot:dragEnd");
  if (wasClick) {
    startListeningFrames();
  } else {
    window.xiaoli?.send?.("activity:record", {
      type: "mascot.drag",
      title: "拖动小力位置"
    });
  }
}

mascotHitArea.addEventListener("pointerup", finishMascotPointer);
mascotHitArea.addEventListener("pointercancel", finishMascotPointer);

shell.addEventListener("mouseenter", (event) => {
  syncMousePassthrough(event);
});

shell.addEventListener("mouseleave", () => {
  shell.classList.remove("hover");
  shell.style.setProperty("--look-x", "0px");
  shell.style.setProperty("--look-y", "0px");
  setMousePassthrough(true);
});

shell.addEventListener("mousemove", (event) => {
  const interactive = syncMousePassthrough(event);
  const rect = shell.getBoundingClientRect();
  const dx = clamp((event.clientX - rect.width / 2) / rect.width, -0.5, 0.5);
  const dy = clamp((event.clientY - rect.height / 2) / rect.height, -0.5, 0.5);
  shell.style.setProperty("--look-x", `${Math.round(interactive ? dx * 8 : 0)}px`);
  shell.style.setProperty("--look-y", `${Math.round(interactive ? dy * 6 : 0)}px`);
});

window.addEventListener("blur", () => {
  cancelAnimationFrame(dragPreviewFrame);
  dragPreviewFrame = 0;
  pendingDragPoint = null;
  if (resizePointer) window.xiaoli.send("mascot:resizeEnd");
  resizePointer = null;
  cancelAnimationFrame(resizePreviewFrame);
  shell.classList.remove("resizing");
  setMousePassthrough(true);
});
window.addEventListener("mouseup", (event) => {
  if (!mascotPointer && !resizePointer) syncMousePassthrough(event);
});

window.xiaoli.on("settings:changed", applySettings);
window.xiaoli.on("mascot:state", applySettings);
window.xiaoli.on("mascot:remind", showBubble);
window.xiaoli.on("mascot:status", (payload = {}) => {
  renderStatusBubble(
    payload.source || "AI小力",
    payload.title || "状态更新",
    payload.body || "",
    Number(payload.autoHideMs || 0)
  );
});
window.xiaoli.on("mascot:timeBlock", applyTimeBlockState);

createStars();
loadMascot();
window.xiaoli.invoke("settings:get").then(applySettings);
requestAnimationFrame(() => setMousePassthrough(true));
