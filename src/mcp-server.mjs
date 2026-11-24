import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BrokerClient } from "./broker-client.mjs";
import { Browser } from "./browser.mjs";

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

  await server.connect(new StdioServerTransport());
}
