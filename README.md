<p align="center"><img src="extension/icons/icon-512.png" width="96" height="96" alt=""></p>

# Agent Computer Use

[npm](https://www.npmjs.com/package/@csltd/agent-computer-use) · [Privacy policy](PRIVACY.md) · [Chrome Web Store submission](docs/chrome-web-store.md) · [Issues](https://github.com/konstantinosbotonakis/agent-computer-use/issues)

Agent Computer Use lets local coding agents (Codex, Claude Code, Gemini CLI, Cursor, OpenCode, Copilot CLI and any other MCP client) work in your real Chrome while you keep using it. Each agent opens its own background tabs, grouped per task, and acts on them with its own pointer and keyboard. Your pointer, focus and current tab are not touched.

It works through a Chrome extension. Chrome's remote debugging stays off, so there is no "Allow remote debugging?" dialog and no permanent "Chrome is being controlled by automated test software" bar.

![Agents work in their own tab groups while you keep working in yours](store/images/screenshot-1-tab-groups.png)

## Install

You need macOS or Linux, Chrome, Chromium, Brave or Edge 116 or later, and Node.js 20 or later.

```sh
npx @csltd/agent-computer-use install
```

`install` registers the native host for every Chromium-based browser it finds and copies the host and the extension to `~/.agent-computer-use`, so nothing depends on the npx cache.

Then:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose `~/.agent-computer-use/extension`. This step goes away once the extension is listed on the Chrome Web Store.
2. Add the MCP server to your agent (below).
3. Check the setup with `npx @csltd/agent-computer-use doctor`. Every line should say `ok`.

The extension cannot work on its own. Chrome only lets an extension talk to programs on your computer through a native messaging host, so the `install` step is always needed. A Chrome Web Store install has a different extension ID; register it with `npx @csltd/agent-computer-use install --extension-id <id>`.

After upgrading the package, run `install` again and reload the extension. `doctor` reports when the two versions differ.

## Add it to your agent

The MCP server is `npx -y @csltd/agent-computer-use mcp`. Use the full path to `npx` if your agent does not inherit your shell's `PATH`.

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agent-computer-use]
command = "npx"
args = ["-y", "@csltd/agent-computer-use", "mcp"]
```

Claude Code:

```sh
claude mcp add -s user agent-computer-use -- npx -y @csltd/agent-computer-use mcp
```

Gemini CLI, Cursor, Windsurf, Kiro and most other clients (`mcpServers` JSON):

```json
{
  "mcpServers": {
    "agent-computer-use": {
      "command": "npx",
      "args": ["-y", "@csltd/agent-computer-use", "mcp"]
    }
  }
}
```

A short line in your agent instructions helps the agent pick the right tool, for example:

> For browser work, use the `agent-computer-use` MCP. Open tabs with `tab_open` and a short emoji-prefixed `group` name per task, read pages with `snapshot`, act with the `[ref=eN]` references it returns, and close your tabs with `tab_close` when done.

## How it works

```mermaid
flowchart LR
  A1[Agent 1] -->|MCP over stdio| M1[agent-computer-use mcp]
  A2[Agent 2] -->|MCP over stdio| M2[agent-computer-use mcp]
  M1 -->|JSON lines| S[(Unix socket<br>~/.agent-computer-use/broker.sock)]
  M2 -->|JSON lines| S
  S --- H[Native host<br>started by Chrome]
  H -->|native messaging| E[Agent Computer Use extension]
  E -->|chrome.debugger| T[Agent tabs in the background]
```

- Chrome starts the native host when the extension loads. The host listens on a Unix socket that only your user account can open.
- Each agent runs `agent-computer-use mcp`, which connects to that socket and exposes browser tools.
- The extension opens agent tabs with `active: false`, puts them in a tab group named after the task, and forwards the agent's DevTools commands to those tabs through `chrome.debugger`.
- Clicks and key presses go straight to the page as DevTools input events. Pages see real, trusted events, and your pointer stays where it is.
- The extension detaches the debugger after two quiet minutes, so Chrome's "started debugging this browser" bar shows only while an agent is working. Dismissing that bar stops the agent on that tab.

![Agents read pages as an outline and act by reference](store/images/screenshot-2-page-outline.png)

## Tools

| Tool | What it does |
|---|---|
| `tabs_list` | Lists every open tab with its id, title, URL and group, and whether you control it |
| `tab_open` | Opens a URL in a new background tab inside a named tab group |
| `tab_claim` | Takes control of a tab you already have open, for when you ask an agent to work in it |
| `tab_close` | Closes a tab the agent controls |
| `navigate` | Loads a URL, or goes back, forward or reloads, and waits for the page |
| `snapshot` | Returns the page as an outline of headings, text, links and controls, with `[ref=eN]` references |
| `click`, `hover` | Clicks or hovers an element by reference |
| `type`, `press_key` | Types into a field, optionally replacing its value or pressing Enter; presses keys and shortcuts |
| `select_option` | Chooses options in a `<select>` |
| `scroll` | Scrolls an element into view or the page by screens |
| `screenshot` | Captures the viewport or the whole page, in PNG or JPEG |
| `evaluate` | Runs JavaScript in the page and returns the result |
| `console_messages`, `network_requests` | Console output, errors and requests since the agent attached |
| `wait_for` | Waits for text to appear or disappear, or for a number of seconds |
| `handle_dialog` | Accepts or dismisses alert, confirm and prompt dialogs |

Snapshots and element lookups run in an isolated script world, so the page's own scripts cannot see or change them.

## Security

- Only this extension can start the native host: its manifest lists the extension's ID in `allowed_origins`.
- The socket lives in `~/.agent-computer-use` with mode `600`, so only processes running as your user can connect. Any such process can use the tools, which is the same trust level as your user account.
- An agent can only send commands to tabs it opened or claimed. `tab_claim` accepts any tab id, so tell your agents to claim a tab only when you ask.
- Agents can read and change everything in the tabs they control, including signed-in sessions. Keep that in mind before you point an agent at an account.
- The extension's popup lists the tabs agents control and has a button to release them all.

![Chrome shows when an agent is working, and the popup releases agent tabs](store/images/screenshot-3-control.png)

## Privacy

Nothing is sent to the developer or any server. The extension passes page content and tab details only to the local program, which passes them to the agents you connect. See [PRIVACY.md](PRIVACY.md).

## Limitations

- Snapshots cover the main page and same-origin iframes. Cross-origin iframes are listed but not expanded.
- Chrome does not let extensions debug `chrome://` pages, the Chrome Web Store or other extensions' pages.
- Chrome slows timers and animations in background tabs.
- Windows is not supported yet, because native host registration there needs the registry.

## Uninstall

```sh
npx @csltd/agent-computer-use uninstall
```

Then remove the extension at `chrome://extensions` and the MCP entry from your agents.

## Development

```sh
git clone https://github.com/konstantinosbotonakis/agent-computer-use.git
cd agent-computer-use
npm install
npm test
node bin/agent-computer-use.mjs install
```

Running `install` from a checkout prints MCP settings that point at the checkout. While developing, load the extension unpacked from the repository's `extension` folder so a reload picks up your changes.

- `npm run package:store` builds the Chrome Web Store upload in `dist/`.
- `node scripts/render-store-images.mjs` renders the store screenshots and promo tile in `store/images` from the HTML in `store/`.
- [docs/chrome-web-store.md](docs/chrome-web-store.md) has the listing text, permission justifications and data disclosures.

## License

MIT. Built by Custom Services Limited.
