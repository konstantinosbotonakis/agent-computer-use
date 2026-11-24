const hostLine = document.getElementById("host");
const summaryLine = document.getElementById("summary");
const tabList = document.getElementById("tabs");
const releaseButton = document.getElementById("release");

async function render() {
  const status = await chrome.runtime.sendMessage({ type: "status" });
  hostLine.textContent = status.hostConnected
    ? "Connected to the local agent bridge."
    : "Not connected to the local agent bridge. Run: agent-computer-use install";
  hostLine.className = status.hostConnected ? "" : "status-off";

  summaryLine.textContent = status.controlledTabs.length
    ? `Agents control ${status.controlledTabs.length} tab(s), ${status.attachedTabs.length} with the debugger attached.`
    : "No tabs are controlled by agents.";
  tabList.replaceChildren();
  for (const tabId of status.controlledTabs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) continue;
    const item = document.createElement("li");
    item.textContent = tab.title || tab.url;
    tabList.append(item);
  }
  releaseButton.hidden = status.controlledTabs.length === 0;
}

releaseButton.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "release-all" });
  render();
});

render();
