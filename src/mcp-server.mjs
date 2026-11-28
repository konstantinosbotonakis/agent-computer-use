import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrokerClient } from "./broker-client.mjs";
import { Browser } from "./browser.mjs";
import { Desktop } from "./desktop.mjs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const DEFAULT_GROUP = process.env.AGENT_COMPUTER_USE_GROUP ?? "🤖 Agent task";

const tabId = z.number().int().describe("Tab id returned by tab_open or tabs_list.");
const ref = z.string().describe('Element reference from the latest snapshot, for example "e12".');

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

function errorResult(error) {
  return { content: [{ type: "text", text: error.message }], isError: true };
}

export async function startMcpServer() {
  const browser = new Browser(new BrokerClient());
  const server = new McpServer({ name: "agent-computer-use", version });

  function tool(name, description, inputSchema, run) {
    server.registerTool(name, { description, inputSchema }, async (args) => {
      try {
        const result = await run(args);
        return typeof result === "string" ? textResult(result) : result;
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  tool(
    "tabs_list",
    "List every tab open in the user's Chrome with its id, title, URL and tab group, and whether you control it. Read-only.",
    {},
    async () => JSON.stringify((await browser.listTabs()).tabs, null, 2),
  );

  tool(
    "tab_open",
    "Open a URL in a new background tab of the user's Chrome, inside a tab group named for your task. The user's focus, pointer and current tab are not touched. Use the same group title for every tab of one task. Returns the tab id that every other tool takes.",
    {
      url: z.string().describe("Address to open, for example https://example.com."),
      group: z.string().optional().describe(`Short emoji-prefixed task name for the tab group, for example "🔎 Check pricing page". Defaults to "${DEFAULT_GROUP}".`),
    },
    ({ url, group }) => browser.openTab({ url, group: group ?? DEFAULT_GROUP }),
  );

  tool(
    "tab_claim",
    "Take control of a tab the user already has open. Only do this when the user asked you to work in that tab. The tab stays where it is.",
    { tabId },
    ({ tabId }) => browser.claimTab(tabId),
  );

  tool("tab_close", "Close a tab you control. Close your tabs when the task is done unless the user wants them kept.", { tabId }, ({ tabId }) =>
    browser.closeTab(tabId),
  );

  tool(
    "navigate",
    "Load a URL in a tab you control, or go back, forward or reload. Waits for the page to load.",
    {
      tabId,
      url: z.string().optional().describe("Address to load."),
      action: z.enum(["back", "forward", "reload"]).optional().describe("Used when no url is given."),
    },
    ({ tabId, url, action }) => {
      if (!url && !action) throw new Error("Give either url or action.");
      return browser.navigate(tabId, { url, action });
    },
  );

  tool(
    "snapshot",
    "Read the page as an outline of headings, text, links and controls. Controls carry [ref=eN] references for click, type, hover and select_option. Take a new snapshot after the page changes, because references from an older snapshot go stale.",
    { tabId },
    ({ tabId }) => browser.snapshot(tabId),
  );

  tool(
    "click",
    "Click an element from the latest snapshot. The click goes straight to the page, so the user's pointer does not move.",
    {
      tabId,
      ref,
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
    },
    ({ tabId, ...options }) => browser.click(tabId, options),
  );

  tool("hover", "Move the agent's pointer over an element, for menus and tooltips.", { tabId, ref }, ({ tabId, ref }) =>
    browser.hover(tabId, { ref }),
  );

  tool(
    "type",
    "Focus a text field or editable element from the latest snapshot and type text into it.",
    {
      tabId,
      ref,
      text: z.string().describe("Text to type."),
      clear: z.boolean().optional().describe("Replace the existing value instead of adding to it."),
      submit: z.boolean().optional().describe("Press Enter afterwards."),
    },
    ({ tabId, ...options }) => browser.type(tabId, options),
  );

  tool(
    "press_key",
    'Press a key or shortcut in the focused element, for example "Enter", "Escape", "ArrowDown", "Tab" or "Meta+a".',
    { tabId, key: z.string() },
    ({ tabId, key }) => browser.pressKey(tabId, { key }),
  );

  tool(
    "select_option",
    "Choose options in a <select> element by value or visible label.",
    { tabId, ref, values: z.array(z.string()).min(1) },
    ({ tabId, ref, values }) => browser.selectOption(tabId, { ref, values }),
  );

  tool(
    "scroll",
    "Scroll an element into view, or scroll the page by a number of screens (negative scrolls up).",
    { tabId, ref: ref.optional(), pages: z.number().optional().describe("Screens to scroll when no ref is given. Defaults to 1.") },
    ({ tabId, ref, pages }) => browser.scroll(tabId, { ref, pages }),
  );

  tool(
    "screenshot",
    "Capture the visible part of the page, or the whole page, as an image.",
    {
      tabId,
      fullPage: z.boolean().optional(),
      format: z.enum(["png", "jpeg"]).optional().describe("jpeg is smaller. Defaults to png."),
    },
    async ({ tabId, fullPage, format }) => {
      const { data, mimeType } = await browser.screenshot(tabId, { fullPage, format });
      return { content: [{ type: "image", data, mimeType }] };
    },
  );

  tool(
    "evaluate",
    "Run a JavaScript expression in the page and return its JSON value. Promises are awaited.",
    { tabId, expression: z.string() },
    ({ tabId, expression }) => browser.evaluate(tabId, { expression }),
  );

  tool(
    "console_messages",
    "Console messages and uncaught errors logged since the agent attached to the tab.",
    { tabId, clear: z.boolean().optional().describe("Empty the list after reading it.") },
    ({ tabId, clear }) => browser.consoleMessages(tabId, { clear }),
  );

  tool(
    "network_requests",
    "Network requests made since the agent attached to the tab, with method, status and URL.",
    {
      tabId,
      filter: z.string().optional().describe("Only requests whose URL contains this text."),
      clear: z.boolean().optional(),
    },
    ({ tabId, filter, clear }) => browser.networkRequests(tabId, { filter, clear }),
  );

  tool(
    "wait_for",
    "Wait until text appears or disappears on the page (up to 15 seconds), or for a number of seconds (up to 30).",
    {
      tabId,
      text: z.string().optional(),
      textGone: z.string().optional(),
      seconds: z.number().optional(),
    },
    ({ tabId, ...options }) => {
      if (!options.text && !options.textGone && !options.seconds) throw new Error("Give text, textGone or seconds.");
      return browser.waitFor(tabId, options);
    },
  );

  tool(
    "handle_dialog",
    "Accept or dismiss an alert, confirm or prompt dialog that the page opened. Other tools refuse to run while one is open.",
    { tabId, accept: z.boolean(), promptText: z.string().optional() },
    ({ tabId, accept, promptText }) => browser.handleDialog(tabId, { accept, promptText }),
  );

  if (process.platform === "darwin") registerDesktopTools(tool);

  await server.connect(new StdioServerTransport());
}

// macOS apps, through the Accessibility API. Reading, actions, menus and set_value keep working
// while the screen is locked; typing, keys and screenshots need it unlocked.
function registerDesktopTools(tool) {
  const desktop = new Desktop();
  const app = z.string().describe('App name, bundle id or process id, for example "Finder", "com.apple.TextEdit" or "4123".');
  const desktopRef = z.string().describe('Element reference from the latest desktop_snapshot, for example "w0.3.1" or "m.2.0".');

  tool(
    "desktop_status",
    "Report whether the Mac's screen is locked, whether the agent has Accessibility and Screen Recording access, and whether keep-awake is on. Read-only.",
    {},
    () => desktop.status(),
  );

  tool(
    "desktop_keep_awake",
    "Turn keep-awake on or off. While on, the display and system do not sleep, so the screen does not lock on idle while the user is away. It lasts until turned off or the user logs out.",
    { on: z.boolean() },
    ({ on }) => desktop.keepAwake({ on }),
  );

  tool(
    "desktop_apps",
    "List the running Mac apps with name, bundle id, process id, whether each is in front or hidden, and their window titles. Read-only.",
    {},
    () => desktop.apps(),
  );

  tool(
    "desktop_open",
    "Open a Mac app, a file or a URL in the background, so the user's front app keeps focus. Give app, url or both (url can be a file path).",
    { app: app.optional(), url: z.string().optional().describe("URL or file path to open, in app when given.") },
    ({ app, url }) => {
      if (!app && !url) throw new Error("Give app, url or both.");
      return desktop.open({ app, url });
    },
  );

  tool(
    "desktop_focus",
    "Bring a Mac app to the front. Shortcuts and menu commands that act on the current selection, such as Cmd+A or Copy, only work in the front app. This changes the app the user sees, so use it only when needed.",
    { app },
    ({ app }) => desktop.focus({ app }),
  );

  tool(
    "desktop_snapshot",
    "Read a Mac app's windows as an outline of controls with their labels, values and actions. Each element carries a [ref=...] reference for desktop_action and desktop_set_value. Take a new snapshot after the app changes. Works while the screen is locked.",
    { app, menus: z.boolean().optional().describe("Also list the menu bar. desktop_menu is usually simpler.") },
    ({ app, menus }) => desktop.snapshot({ app, menus }),
  );

  tool(
    "desktop_action",
    'Perform an accessibility action on an element from the latest desktop_snapshot, for example "Press" (the default), "ShowMenu", "Increment", "Decrement", "Confirm" or "Raise". The user\'s pointer does not move. Works while the screen is locked.',
    { app, ref: desktopRef, action: z.string().optional() },
    ({ app, ref, action }) => desktop.action({ app, ref, action }),
  );

  tool(
    "desktop_set_value",
    "Replace the value of a text field or other editable element from the latest desktop_snapshot. Works while the screen is locked.",
    { app, ref: desktopRef, value: z.string() },
    ({ app, ref, value }) => desktop.setValue({ app, ref, value }),
  );

  tool(
    "desktop_menu",
    'Choose a menu bar command by its titles, for example ["File", "New Window"] or ["Format", "Font", "Bold"]. The menu does not open on screen. Works while the screen is locked.',
    { app, path: z.array(z.string()).min(1) },
    ({ app, path }) => desktop.menu({ app, path }),
  );

  tool(
    "desktop_type",
    "Type text into the focused element of a Mac app. The keystrokes go to that app only, so it does not need to be in front. Needs the screen unlocked; use desktop_set_value when it is locked.",
    { app, text: z.string() },
    ({ app, text }) => desktop.type({ app, text }),
  );

  tool(
    "desktop_press_key",
    'Press a key or shortcut in a Mac app, for example "Enter", "Escape", "Tab", "ArrowDown", "F5" or "Cmd+S". Goes to that app only. Needs the screen unlocked; use desktop_menu or desktop_action when it is locked.',
    { app, key: z.string() },
    ({ app, key }) => desktop.pressKey({ app, key }),
  );

  tool(
    "desktop_screenshot",
    "Capture the front window of a Mac app, or the whole screen when no app is given, as a PNG. Needs the screen unlocked.",
    { app: app.optional() },
    async ({ app }) => {
      const { data, mimeType } = await desktop.screenshot({ app });
      return { content: [{ type: "image", data, mimeType }] };
    },
  );
}
