import { parseKeyCombo } from "./keys.mjs";
import { describePage, focusElement, locateElement, readPageText, scrollPage, selectOptions, snapshotPage } from "./page-scripts.mjs";

const SNAPSHOT_MAX_LENGTH = 40_000;
const CONSOLE_LIMIT = 500;
const NETWORK_LIMIT = 300;
const LOAD_TIMEOUT_MS = 30_000;
const ISOLATED_WORLD_NAME = "agent-computer-use";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function trimToLimit(list, limit) {
  if (list.length > limit) list.splice(0, list.length - limit);
}

function formatRemoteValue(remote) {
  if (remote.value !== undefined) return typeof remote.value === "string" ? remote.value : JSON.stringify(remote.value);
  return remote.description ?? remote.type;
}

// What the agent knows about one of its tabs. Events from Chrome keep it current.
class TabState {
  worldContextId = null;
  mainFrameId = null;
  loading = false;
  dialog = null;
  stoppedByUser = false;
  consoleMessages = [];
  networkRequests = new Map(); // request id -> summary
  loadWaiters = [];
}

// Tab-level browser actions for one agent, built on the native host bridge.
export class Browser {
  #broker;
  #tabs = new Map(); // tab id -> TabState

  constructor(broker) {
    this.#broker = broker;
    broker.onEvent((message) => this.#handleEvent(message));
  }

  #state(tabId) {
    if (!this.#tabs.has(tabId)) this.#tabs.set(tabId, new TabState());
    return this.#tabs.get(tabId);
  }

  #handleEvent({ event, params }) {
    if (event === "bridge.closed") {
      this.#tabs.clear();
      return;
    }
    const state = this.#tabs.get(params.tabId);
    if (!state) return;
    if (event === "tab.closed" || event === "tab.released") {
      this.#tabs.delete(params.tabId);
    } else if (event === "tab.detached") {
      state.worldContextId = null;
      if (params.reason === "canceled_by_user") state.stoppedByUser = true;
    } else if (event === "cdp.event") {
      this.#handleDevToolsEvent(state, params.method, params.params);
    }
  }

  #handleDevToolsEvent(state, method, params) {
    const isMainFrame = (frameId) => !state.mainFrameId || frameId === state.mainFrameId;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const frame = params.stackTrace?.callFrames?.[0];
        state.consoleMessages.push({
          level: params.type,
          text: params.args.map(formatRemoteValue).join(" "),
          location: frame ? `${frame.url}:${frame.lineNumber + 1}` : "",
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails;
        state.consoleMessages.push({
          level: "error",
          text: details.exception?.description ?? details.text,
          location: details.url ? `${details.url}:${details.lineNumber + 1}` : "",
        });
        break;
      }
      case "Log.entryAdded":
        state.consoleMessages.push({ level: params.entry.level, text: params.entry.text, location: params.entry.url ?? "" });
        break;
      case "Network.requestWillBeSent":
        state.networkRequests.set(params.requestId, {
          method: params.request.method,
          url: params.request.url,
          type: params.type ?? "",
          status: "pending",
        });
        if (state.networkRequests.size > NETWORK_LIMIT) state.networkRequests.delete(state.networkRequests.keys().next().value);
        break;
      case "Network.responseReceived": {
        const request = state.networkRequests.get(params.requestId);
        if (request) request.status = String(params.response.status);
        break;
      }
      case "Network.loadingFailed": {
        const request = state.networkRequests.get(params.requestId);
        if (request) request.status = params.canceled ? "canceled" : `failed (${params.errorText})`;
        break;
      }
      case "Page.javascriptDialogOpening":
        state.dialog = { type: params.type, message: params.message, defaultPrompt: params.defaultPrompt ?? "" };
        break;
      case "Page.javascriptDialogClosed":
        state.dialog = null;
        break;
      case "Page.frameStartedLoading":
        if (isMainFrame(params.frameId)) state.loading = true;
        break;
      case "Page.frameStoppedLoading":
        if (isMainFrame(params.frameId)) {
          state.loading = false;
          for (const resolve of state.loadWaiters.splice(0)) resolve("loaded");
        }
        break;
      case "Page.frameNavigated":
        if (!params.frame.parentId) {
          state.mainFrameId = params.frame.id;
          state.worldContextId = null;
          // Pages restored from the back/forward cache do not fire a load event.
          if (params.type === "BackForwardCacheRestore") {
            for (const resolve of state.loadWaiters.splice(0)) resolve("loaded");
          }
        }
        break;
      case "Runtime.executionContextsCleared":
        state.worldContextId = null;
        break;
      case "Page.loadEventFired":
      case "Page.navigatedWithinDocument":
        for (const resolve of state.loadWaiters.splice(0)) resolve("loaded");
        break;
    }
    trimToLimit(state.consoleMessages, CONSOLE_LIMIT);
  }

  cdp(tabId, method, params = {}, timeoutMs) {
    return this.#broker.request("cdp.send", { tabId, method, params }, timeoutMs);
  }

  // Attaches the debugger if needed and turns on the event streams this class relies on.
  async #ready(tabId, { allowDialog = false } = {}) {
    const state = this.#state(tabId);
    if (state.stoppedByUser) {
      throw new Error(`The user stopped agent control of tab ${tabId} by dismissing Chrome's debugging bar. Ask the user before continuing.`);
    }
    const { fresh } = await this.#broker.request("tabs.attach", { tabId });
    if (fresh) {
      state.worldContextId = null;
      await this.cdp(tabId, "Page.enable");
      await this.cdp(tabId, "Runtime.enable");
      await this.cdp(tabId, "Log.enable");
      await this.cdp(tabId, "Network.enable");
      // Lets background tabs behave as if focused, so focus and keyboard events work.
      await this.cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true });
    }
    if (state.dialog && !allowDialog) {
      throw new Error(`A JavaScript ${state.dialog.type} is open: "${state.dialog.message}". Answer it with handle_dialog first.`);
    }
    return state;
  }

  async #worldContext(tabId) {
    const state = this.#state(tabId);
    if (state.worldContextId) return state.worldContextId;
    const { frameTree } = await this.cdp(tabId, "Page.getFrameTree");
    state.mainFrameId = frameTree.frame.id;
    const { executionContextId } = await this.cdp(tabId, "Page.createIsolatedWorld", {
      frameId: frameTree.frame.id,
      worldName: ISOLATED_WORLD_NAME,
    });
    state.worldContextId = executionContextId;
    return executionContextId;
  }

  // Runs one of the page-scripts.mjs functions in the agent's isolated world.
  async #runInPage(tabId, pageFunction, args = {}, timeoutMs) {
    const expression = `(${pageFunction.toString()})(${JSON.stringify(args)})`;
    for (let attempt = 1; ; attempt++) {
      const contextId = await this.#worldContext(tabId);
      try {
        const response = await this.cdp(
          tabId,
          "Runtime.evaluate",
          { expression, contextId, returnByValue: true, awaitPromise: true },
          timeoutMs,
        );
        if (response.exceptionDetails) {
          throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
        }
        const value = response.result.value;
        if (value?.error) throw new Error(value.error);
        return value;
      } catch (error) {
        // The isolated world disappears when the page navigates; create a new one once.
        if (attempt === 1 && /context/i.test(error.message)) {
          this.#state(tabId).worldContextId = null;
          continue;
        }
        throw error;
      }
    }
  }

  async #waitForDocument(tabId, { leaveBlank }) {
    const deadline = Date.now() + LOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const { result } = await this.cdp(tabId, "Runtime.evaluate", {
        expression: "({ readyState: document.readyState, url: location.href })",
        returnByValue: true,
      });
      if (result.value.readyState === "complete" && !(leaveBlank && result.value.url === "about:blank")) return;
      await sleep(250);
    }
  }

  async #navigateAndWait(tabId, startNavigation) {
    const state = this.#state(tabId);
    const loaded = new Promise((resolve) => {
      state.loadWaiters.push(resolve);
      setTimeout(resolve, LOAD_TIMEOUT_MS, "timeout");
    });
    const outcome = await startNavigation();
    if (outcome?.errorText) {
      state.loadWaiters = [];
      throw new Error(`Navigation failed: ${outcome.errorText}`);
    }
    const result = await loaded;
    return result === "timeout" ? "The page did not finish loading within 30 seconds." : "";
  }

  // Gives a click or key press time to start a navigation, then waits for it to finish.
  async #settle(tabId) {
    await sleep(300);
    const state = this.#state(tabId);
    const deadline = Date.now() + 10_000;
    while (state.loading && Date.now() < deadline) await sleep(200);
  }

  // Describes the page after an action. A dialog the action opened blocks page scripts, so it
  // is reported instead.
  async #summary(tabId, prefix) {
    const state = this.#state(tabId);
    const dialogNote = () => `${prefix}\nThe page opened a JavaScript ${state.dialog.type}: "${state.dialog.message}". Answer it with handle_dialog.`;
    if (state.dialog) return dialogNote();
    try {
      const { title, url } = await this.#runInPage(tabId, describePage, {}, 5_000);
      return `${prefix}\nPage: ${title}\nURL: ${url}`;
    } catch (error) {
      if (state.dialog) return dialogNote();
      throw error;
    }
  }

  listTabs() {
    return this.#broker.request("tabs.list");
  }

  async openTab({ url, group }) {
    const { tabId } = await this.#broker.request("tabs.open", { url, group });
    await this.#ready(tabId);
    if (url && url !== "about:blank") await this.#waitForDocument(tabId, { leaveBlank: true });
    return this.#summary(tabId, `Opened tab ${tabId} in the background, in the tab group "${group}".`);
  }

  async claimTab(tabId) {
    await this.#broker.request("tabs.claim", { tabId });
    await this.#ready(tabId);
    return this.#summary(tabId, `You now control tab ${tabId}. It stays in its current group and position.`);
  }

  async closeTab(tabId) {
    await this.#broker.request("tabs.close", { tabId });
    this.#tabs.delete(tabId);
    return `Closed tab ${tabId}.`;
  }

  async navigate(tabId, { url, action }) {
    await this.#ready(tabId);
    let note;
    if (url) {
      note = await this.#navigateAndWait(tabId, () => this.cdp(tabId, "Page.navigate", { url }));
    } else if (action === "reload") {
      note = await this.#navigateAndWait(tabId, () => this.cdp(tabId, "Page.reload"));
    } else {
      const { currentIndex, entries } = await this.cdp(tabId, "Page.getNavigationHistory");
      const entry = entries[currentIndex + (action === "back" ? -1 : 1)];
      if (!entry) throw new Error(`There is no page to go ${action} to.`);
      note = await this.#navigateAndWait(tabId, () => this.cdp(tabId, "Page.navigateToHistoryEntry", { entryId: entry.id }));
    }
    return this.#summary(tabId, note || "Navigation finished.");
  }

  async snapshot(tabId) {
    await this.#ready(tabId);
    const { text } = await this.#runInPage(tabId, snapshotPage, { maxLength: SNAPSHOT_MAX_LENGTH });
    return text;
  }

  async #mouseAt(tabId, ref, events) {
    const { x, y } = await this.#runInPage(tabId, locateElement, { ref });
    for (const event of events) await this.cdp(tabId, "Input.dispatchMouseEvent", { x, y, ...event });
  }

  async click(tabId, { ref, button = "left", doubleClick = false }) {
    await this.#ready(tabId);
    const clickCount = doubleClick ? 2 : 1;
    await this.#mouseAt(tabId, ref, [
      { type: "mouseMoved" },
      { type: "mousePressed", button, clickCount },
      { type: "mouseReleased", button, clickCount },
    ]);
    await this.#settle(tabId);
    return this.#summary(tabId, `Clicked ${ref}.`);
  }

  async hover(tabId, { ref }) {
    await this.#ready(tabId);
    await this.#mouseAt(tabId, ref, [{ type: "mouseMoved" }]);
    return `Moved the agent's pointer over ${ref}. The user's own pointer did not move.`;
  }

  async #pressKey(tabId, key) {
    const { keyDown, keyUp } = parseKeyCombo(key);
    await this.cdp(tabId, "Input.dispatchKeyEvent", keyDown);
    await this.cdp(tabId, "Input.dispatchKeyEvent", keyUp);
  }

  async type(tabId, { ref, text, clear = false, submit = false }) {
    await this.#ready(tabId);
    await this.#runInPage(tabId, focusElement, { ref, clear });
    if (text) await this.cdp(tabId, "Input.insertText", { text });
    else if (clear) await this.#pressKey(tabId, "Backspace");
    if (submit) {
      await this.#pressKey(tabId, "Enter");
      await this.#settle(tabId);
    }
    return this.#summary(tabId, `Typed into ${ref}${submit ? " and pressed Enter" : ""}.`);
  }

  async pressKey(tabId, { key }) {
    await this.#ready(tabId);
    await this.#pressKey(tabId, key);
    await this.#settle(tabId);
    return this.#summary(tabId, `Pressed ${key}.`);
  }

  async selectOption(tabId, { ref, values }) {
    await this.#ready(tabId);
    const { selected } = await this.#runInPage(tabId, selectOptions, { ref, values });
    return `Selected ${selected.map((label) => `"${label}"`).join(", ")} in ${ref}.`;
  }

  async scroll(tabId, { ref, pages = 1 }) {
    await this.#ready(tabId);
    if (ref) {
      await this.#runInPage(tabId, locateElement, { ref });
      return `Scrolled ${ref} into view.`;
    }
    const { viewportHeight } = await this.#runInPage(tabId, scrollPage, { pixels: 0 });
    const position = await this.#runInPage(tabId, scrollPage, { pixels: Math.round(pages * viewportHeight * 0.9) });
    return `Scrolled to ${position.scrollY} of ${position.pageHeight} pixels (viewport ${position.viewportHeight}).`;
  }

  async screenshot(tabId, { fullPage = false, format = "png" }) {
    await this.#ready(tabId);
    const options = { format, captureBeyondViewport: fullPage };
    if (format === "jpeg") options.quality = 80;
    if (fullPage) {
      const { cssContentSize } = await this.cdp(tabId, "Page.getLayoutMetrics");
      options.clip = { x: 0, y: 0, width: cssContentSize.width, height: cssContentSize.height, scale: 1 };
    }
    const { data } = await this.cdp(tabId, "Page.captureScreenshot", options, 20_000);
    return { data, mimeType: `image/${format}` };
  }

  async evaluate(tabId, { expression }) {
    await this.#ready(tabId);
    const response = await this.cdp(tabId, "Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      timeout: 10_000,
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
    }
    const { result } = response;
    if (result.type === "undefined") return "undefined";
    return result.value !== undefined ? JSON.stringify(result.value, null, 2) : result.description ?? result.type;
  }

  async consoleMessages(tabId, { clear = false }) {
    const state = await this.#ready(tabId, { allowDialog: true });
    const lines = state.consoleMessages.map((message) => `[${message.level}] ${message.text}${message.location ? ` (${message.location})` : ""}`);
    if (clear) state.consoleMessages = [];
    return lines.length ? lines.join("\n") : "No console messages since the agent attached to this tab.";
  }

  async networkRequests(tabId, { filter, clear = false }) {
    const state = await this.#ready(tabId, { allowDialog: true });
    const lines = [...state.networkRequests.values()]
      .filter((request) => !filter || request.url.includes(filter))
      .map((request) => `${request.method} ${request.status} ${request.url}${request.type ? ` (${request.type})` : ""}`);
    if (clear) state.networkRequests.clear();
    return lines.length ? lines.join("\n") : "No matching network requests since the agent attached to this tab.";
  }

  async waitFor(tabId, { text, textGone, seconds }) {
    await this.#ready(tabId);
    if (seconds) {
      await sleep(Math.min(seconds, 30) * 1000);
      return `Waited ${Math.min(seconds, 30)} seconds.`;
    }
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const pageText = await this.#runInPage(tabId, readPageText);
      if (text && pageText.includes(text)) return `"${text}" is on the page.`;
      if (textGone && !pageText.includes(textGone)) return `"${textGone}" is no longer on the page.`;
      await sleep(300);
    }
    throw new Error(`Timed out after 15 seconds waiting for ${text ? `"${text}" to appear` : `"${textGone}" to disappear`}.`);
  }

  async handleDialog(tabId, { accept, promptText }) {
    const state = await this.#ready(tabId, { allowDialog: true });
    if (!state.dialog) return "No dialog is open.";
    const { type, message } = state.dialog;
    await this.cdp(tabId, "Page.handleJavaScriptDialog", { accept, promptText });
    state.dialog = null;
    return `${accept ? "Accepted" : "Dismissed"} the JavaScript ${type} "${message}".`;
  }
}
