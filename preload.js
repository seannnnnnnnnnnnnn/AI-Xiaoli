const { contextBridge, ipcRenderer } = require("electron");

const invokeChannels = new Set([
  "settings:get",
  "settings:update",
  "settings:open",
  "settings:openJustNow",
  "reminders:list",
  "reminders:create",
  "reminders:update",
  "reminders:delete",
  "reminders:snooze",
  "mascot:triggerAnimation",
  "ai:getConfig",
  "ai:updateConfig",
  "ai:test",
  "ai:summarize",
  "summaryTemplates:list",
  "summaryTemplates:save",
  "summaryTemplates:delete",
  "summaryHistory:list",
  "summaryHistory:get",
  "justNowTemplate:get",
  "justNowTemplate:update",
  "justNow:recordStart",
  "justNow:recordStop",
  "justNow:summarize",
  "justNowHistory:list",
  "justNowHistory:get"
]);

const eventChannels = new Set([
  "settings:changed",
  "settings:focusCreate",
  "settings:focusAi",
  "settings:focusJustNow",
  "reminders:changed",
  "mascot:remind",
  "mascot:state",
  "mascot:timeBlock"
]);

const sendChannels = new Set([
  "mascot:setMousePassthrough",
  "mascot:setBubbleInteractive",
  "mascot:dragStart",
  "mascot:dragMove",
  "mascot:dragEnd",
  "mascot:resizeStart",
  "mascot:resizeMove",
  "mascot:resizeEnd",
  "activity:record"
]);

contextBridge.exposeInMainWorld("xiaoli", {
  invoke(channel, payload) {
    if (!invokeChannels.has(channel)) {
      return Promise.reject(new Error(`Unsupported channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel, payload) {
    if (!sendChannels.has(channel)) {
      throw new Error(`Unsupported channel: ${channel}`);
    }
    ipcRenderer.send(channel, payload);
  },
  on(channel, callback) {
    if (!eventChannels.has(channel)) {
      throw new Error(`Unsupported event channel: ${channel}`);
    }
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
