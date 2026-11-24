// Agent Computer Use background worker.
//
// Local coding agents reach this worker through the native host (com.agentcomputeruse.host).
// The worker opens the agents' tabs in the background, keeps each task's tabs in its own tab
// group, and forwards each agent's DevTools commands to the tabs it owns through
// chrome.debugger. Agents never get Chrome's remote debugging port, and they can only reach
// tabs they opened or that they claimed on the user's request.

const NATIVE_HOST = "com.agentcomputeruse.host";
const DEBUGGER_PROTOCOL_VERSION = "1.3";
const RECONNECT_DELAY_MS = 10 * 1000;
// Chrome shows its "started debugging this browser" bar while the debugger is attached, so
// the worker detaches from a tab once its agent has been quiet for this long.
const IDLE_DETACH_MS = 2 * 60 * 1000;

let hostPort = null;
const tabOwners = new Map(); // tab id -> agent id
const detachTimers = new Map(); // attached tab id -> idle detach timer
const pendingAttaches = new Map(); // tab id -> attach promise

function connectHost() {
  if (hostPort) return;
  hostPort = chrome.runtime.connectNative(NATIVE_HOST);
  hostPort.onMessage.addListener(handleHostMessage);
  hostPort.onDisconnect.addListener(() => {
    console.warn("Agent Computer Use host disconnected:", chrome.runtime.lastError?.message);
    hostPort = null;
    for (const tabId of tabOwners.keys()) releaseTab(tabId);
    setTimeout(connectHost, RECONNECT_DELAY_MS);
  });
}

function postToHost(message) {
  hostPort?.postMessage(message);
}

function notifyOwner(tabId, event, params = {}) {
  const agent = tabOwners.get(tabId);
  if (agent !== undefined) postToHost({ agent, event, params: { ...params, tabId } });
}

async function handleHostMessage(message) {
  if (message.op === "agent.disconnected") {
    releaseAgent(message.agent);
    return;
  }
  const operation = operations[message.op];
  try {
    if (!operation) throw new Error(`Unknown operation "${message.op}".`);
    const result = await operation(message.agent, message.params ?? {});
    postToHost({ agent: message.agent, id: message.id, result: result ?? {} });
  } catch (error) {
    postToHost({ agent: message.agent, id: message.id, error: error.message });
  }
}

function requireOwnedTab(agent, tabId) {
  if (tabOwners.get(tabId) !== agent) {
    throw new Error(`Tab ${tabId} is not controlled by this agent. Open a tab with tab_open, or claim one the user named with tab_claim.`);
  }
}

async function listTabs(agent) {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const groupTitles = new Map(groups.map((group) => [group.id, group.title]));
  return {
    tabs: tabs.map((tab) => ({
      tabId: tab.id,
      title: tab.title,
      url: tab.url,
      group: groupTitles.get(tab.groupId) ?? null,
      active: tab.active,
      controlledByYou: tabOwners.get(tab.id) === agent,
      controlledByAnotherAgent: tabOwners.has(tab.id) && tabOwners.get(tab.id) !== agent,
    })),
  };
}

async function addToGroup(tab, title, color) {
  const [existingGroup] = await chrome.tabGroups.query({ windowId: tab.windowId, title });
  if (existingGroup) {
    await chrome.tabs.group({ groupId: existingGroup.id, tabIds: tab.id });
    return;
  }
  const groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, color ? { title, color } : { title });
}

async function openTab(agent, { url, group, color }) {
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const tab = await chrome.tabs.create({ windowId: window.id, url: url || "about:blank", active: false });
  tabOwners.set(tab.id, agent);
  if (group) await addToGroup(tab, group, color);
  return { tabId: tab.id };
}

async function claimTab(agent, { tabId }) {
  await chrome.tabs.get(tabId);
  const owner = tabOwners.get(tabId);
  if (owner !== undefined && owner !== agent) throw new Error(`Tab ${tabId} is controlled by another agent.`);
  tabOwners.set(tabId, agent);
  return { tabId };
}

async function closeTab(agent, { tabId }) {
  requireOwnedTab(agent, tabId);
  releaseTab(tabId);
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

// Returns { fresh: true } when this call attached the debugger, so the agent knows to
// re-enable the DevTools domains it relies on.
async function attachTab(agent, { tabId }) {
  requireOwnedTab(agent, tabId);
  const fresh = await ensureAttached(tabId);
  scheduleIdleDetach(tabId);
  return { fresh };
}

async function ensureAttached(tabId) {
  if (detachTimers.has(tabId)) return false;
  if (!pendingAttaches.has(tabId)) {
    const attach = chrome.debugger
      .attach({ tabId }, DEBUGGER_PROTOCOL_VERSION)
      .then(() => detachTimers.set(tabId, null))
      .finally(() => pendingAttaches.delete(tabId));
    pendingAttaches.set(tabId, attach);
    await attach;
    return true;
  }
  await pendingAttaches.get(tabId);
  return false;
}

function scheduleIdleDetach(tabId) {
  clearTimeout(detachTimers.get(tabId));
  detachTimers.set(tabId, setTimeout(() => detachTab(tabId), IDLE_DETACH_MS));
}

function detachTab(tabId) {
  if (!detachTimers.has(tabId)) return;
  clearTimeout(detachTimers.get(tabId));
  detachTimers.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

async function sendCommand(agent, { tabId, method, params }) {
  requireOwnedTab(agent, tabId);
  await ensureAttached(tabId);
  scheduleIdleDetach(tabId);
  return chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}

function releaseTab(tabId) {
  detachTab(tabId);
  tabOwners.delete(tabId);
}

function releaseAgent(agent) {
  for (const [tabId, owner] of tabOwners) {
    if (owner === agent) releaseTab(tabId);
  }
}

const operations = {
  ping: () => ({ version: chrome.runtime.getManifest().version }),
  "tabs.list": listTabs,
  "tabs.open": openTab,
  "tabs.claim": claimTab,
  "tabs.close": closeTab,
  "tabs.attach": attachTab,
  "cdp.send": sendCommand,
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  notifyOwner(source.tabId, "cdp.event", { method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  clearTimeout(detachTimers.get(source.tabId));
  detachTimers.delete(source.tabId);
  // "canceled_by_user" means the user dismissed Chrome's debugging bar.
  notifyOwner(source.tabId, "tab.detached", { reason });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  notifyOwner(tabId, "tab.closed");
  releaseTab(tabId);
});

// The popup asks for status and can release every agent tab at once.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "status") {
    sendResponse({
      hostConnected: hostPort !== null,
      controlledTabs: [...tabOwners.keys()],
      attachedTabs: [...detachTimers.keys()],
    });
  } else if (message.type === "release-all") {
    for (const tabId of [...tabOwners.keys()]) {
      notifyOwner(tabId, "tab.released");
      releaseTab(tabId);
    }
    sendResponse({ released: true });
  }
});

// Registering onStartup makes Chrome start this worker, and so the host, when the browser opens.
chrome.runtime.onStartup.addListener(connectHost);
chrome.runtime.onInstalled.addListener(connectHost);
connectHost();
