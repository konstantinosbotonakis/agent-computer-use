#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BROKER_SOCKET, EXTENSION_ID, HOST_LAUNCHER, NATIVE_HOST_NAME, STATE_DIR } from "../src/paths.mjs";

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXTENSION_DIR = path.join(PROJECT_DIR, "extension");
const NATIVE_HOST_SCRIPT = path.join(PROJECT_DIR, "src", "native-host.mjs");
const CLI_SCRIPT = fileURLToPath(import.meta.url);

// Folders where Chromium-based browsers look for native messaging host manifests.
function nativeHostDirectories() {
  const home = os.homedir();
  const browserDirectories =
    process.platform === "darwin"
      ? [
          "Library/Application Support/Google/Chrome",
          "Library/Application Support/Google/Chrome Beta",
          "Library/Application Support/Google/Chrome Canary",
          "Library/Application Support/Chromium",
          "Library/Application Support/BraveSoftware/Brave-Browser",
          "Library/Application Support/Microsoft Edge",
        ]
      : [".config/google-chrome", ".config/google-chrome-beta", ".config/chromium", ".config/BraveSoftware/Brave-Browser", ".config/microsoft-edge"];
  return browserDirectories
    .map((directory) => path.join(home, directory))
    .filter((directory) => fs.existsSync(directory))
    .map((directory) => path.join(directory, "NativeMessagingHosts"));
}

// The unpacked extension always has EXTENSION_ID. A Chrome Web Store install has the ID the
// store assigned, passed with --extension-id. IDs allowed by an earlier install are kept.
function allowedOrigins(manifestPath, extraIds) {
  const origins = new Set([`chrome-extension://${EXTENSION_ID}/`]);
  if (fs.existsSync(manifestPath)) {
    for (const origin of JSON.parse(fs.readFileSync(manifestPath, "utf8")).allowed_origins ?? []) origins.add(origin);
  }
  for (const id of extraIds) {
    if (!/^[a-p]{32}$/.test(id)) throw new Error(`"${id}" is not a Chrome extension ID.`);
    origins.add(`chrome-extension://${id}/`);
  }
  return [...origins];
}

function install(extraIds) {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("Agent Computer Use supports macOS and Linux.");
  }
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  // Chrome starts native hosts with a minimal environment, so the launcher names node by its full path.
  fs.writeFileSync(HOST_LAUNCHER, `#!/bin/sh\nexec "${process.execPath}" "${NATIVE_HOST_SCRIPT}"\n`, { mode: 0o755 });
  const directories = nativeHostDirectories();
  if (directories.length === 0) throw new Error("No Chrome, Chromium, Brave or Edge profile folder was found.");
  for (const directory of directories) {
    const manifestPath = path.join(directory, `${NATIVE_HOST_NAME}.json`);
    const manifest = {
      name: NATIVE_HOST_NAME,
      description: "Agent Computer Use bridge between local coding agents and the browser extension",
      path: HOST_LAUNCHER,
      type: "stdio",
      allowed_origins: allowedOrigins(manifestPath, extraIds),
    };
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`Registered the native host for ${path.dirname(directory)}`);
  }
  console.log(`
Next steps:
1. Install the extension from the Chrome Web Store, or open chrome://extensions, turn on
   Developer mode, click "Load unpacked" and choose:
   ${EXTENSION_DIR}
   (If the extension was already loaded, click its reload button instead.)
2. Add this MCP server to your agent:
   command: ${process.execPath}
   args:    ["${CLI_SCRIPT}", "mcp"]
3. Run: agent-computer-use doctor`);
}

function uninstall() {
  for (const directory of nativeHostDirectories()) {
    fs.rmSync(path.join(directory, `${NATIVE_HOST_NAME}.json`), { force: true });
  }
  fs.rmSync(HOST_LAUNCHER, { force: true });
  console.log("Removed the native host registration. Remove the extension at chrome://extensions.");
}

function ping() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(BROKER_SOCKET);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the extension did not answer within 5 seconds"));
    }, 5000);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(JSON.stringify({ id: 1, op: "ping" }) + "\n"));
    socket.once("data", (line) => {
      clearTimeout(timer);
      socket.end();
      const message = JSON.parse(line.split("\n")[0]);
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function doctor() {
  let healthy = true;
  const report = (ok, message) => {
    healthy &&= ok;
    console.log(`${ok ? "ok  " : "FAIL"} ${message}`);
  };
  const manifests = nativeHostDirectories().filter((directory) => fs.existsSync(path.join(directory, `${NATIVE_HOST_NAME}.json`)));
  report(manifests.length > 0, manifests.length ? `native host registered for ${manifests.length} browser(s)` : "native host not registered: run agent-computer-use install");
  report(fs.existsSync(HOST_LAUNCHER), fs.existsSync(HOST_LAUNCHER) ? `host launcher at ${HOST_LAUNCHER}` : "host launcher missing: run agent-computer-use install");
  try {
    const { version } = await ping();
    report(true, `extension ${version} answered through ${BROKER_SOCKET}`);
  } catch (error) {
    report(false, `extension not reachable (${error.code ?? error.message}). Check that Chrome is running and the extension is loaded and enabled.`);
  }
  process.exitCode = healthy ? 0 : 1;
}

const [command = "help", ...options] = process.argv.slice(2);
if (command === "install") {
  const extraIds = options.flatMap((option, index) => (option === "--extension-id" ? [options[index + 1]] : []));
  install(extraIds);
}
else if (command === "uninstall") uninstall();
else if (command === "doctor") await doctor();
else if (command === "mcp") await (await import("../src/mcp-server.mjs")).startMcpServer();
else console.log("Usage: agent-computer-use <install [--extension-id <id>] | uninstall | doctor | mcp>");
