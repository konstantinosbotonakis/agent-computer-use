import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { STATE_DIR } from "./paths.mjs";

const run = promisify(execFile);
const HELPER_SOURCE = new URL("./desktop-helper.swift", import.meta.url).pathname;
const KEEP_AWAKE_LABEL = "com.agentcomputeruse.keepawake";
const BUNDLE_ID = /^[\w-]+(\.[\w-]+)+$/;

// The helper is compiled once per source version. Processes the agent starts inherit the agent
// app's Accessibility and Screen Recording permissions, so the binary needs no grant of its own.
export async function ensureHelper() {
  const source = fs.readFileSync(HELPER_SOURCE);
  const hash = crypto.createHash("sha256").update(source).digest("hex").slice(0, 12);
  const helper = path.join(STATE_DIR, "desktop", `desktop-helper-${hash}`);
  if (fs.existsSync(helper)) return helper;
  fs.mkdirSync(path.dirname(helper), { recursive: true, mode: 0o700 });
  // Several agents can start at once, so each compiles to its own file and renames it into place.
  const partial = `${helper}.${process.pid}`;
  try {
    await run("swiftc", ["-O", "-swift-version", "5", HELPER_SOURCE, "-o", partial], { timeout: 180_000 });
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Could not compile the desktop helper. Install the Xcode Command Line Tools with xcode-select --install. ${error.stderr || error.message}`);
  }
  fs.renameSync(partial, helper);
  return helper;
}

async function helper(command, args = {}) {
  const { stdout } = await run(await ensureHelper(), [command, JSON.stringify(args)], { timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  const message = JSON.parse(stdout);
  if (message.error) throw new Error(message.error);
  return message.result;
}

async function keepAwakeIsOn() {
  try {
    await run("launchctl", ["list", KEEP_AWAKE_LABEL]);
    return true;
  } catch {
    return false;
  }
}

export class Desktop {
  async status() {
    const status = await helper("status");
    return JSON.stringify({ ...status, keepAwake: await keepAwakeIsOn() }, null, 2);
  }

  async apps() {
    return JSON.stringify(await helper("apps"), null, 2);
  }

  // -g opens in the background, so the user's front app keeps focus.
  async open({ app, url }) {
    const args = ["-g"];
    if (app) args.push(BUNDLE_ID.test(app) ? "-b" : "-a", app);
    if (url) args.push(url);
    await run("open", args);
    return `Opened ${[app, url].filter(Boolean).join(" with ")}.`;
  }

  // Brings the app to the front, which commands on the current selection need.
  async focus({ app }) {
    await run("open", [BUNDLE_ID.test(app) ? "-b" : "-a", app]);
    return helper("wait_front", { app });
  }

  snapshot({ app, menus }) {
    return helper("snapshot", { app, menus });
  }

  action({ app, ref, action }) {
    return helper("action", { app, ref, action });
  }

  setValue({ app, ref, value }) {
    return helper("set_value", { app, ref, value });
  }

  menu({ app, path: menuPath }) {
    return helper("menu", { app, path: menuPath });
  }

  pressKey({ app, key }) {
    return helper("press_key", { app, key });
  }

  type({ app, text }) {
    return helper("type", { app, text });
  }

  async screenshot({ app }) {
    const { screenLocked } = await helper("status");
    if (screenLocked) throw new Error("The screen is locked, so macOS only returns the lock screen. Use desktop_snapshot to read the app instead.");
    const args = ["-x", "-o", "-t", "png"];
    if (app) {
      const [front] = await helper("windows", { app });
      if (!front) throw new Error(`${app} has no window on screen.`);
      args.push("-l", String(front.id));
    }
    const file = path.join(os.tmpdir(), `agent-computer-use-${process.pid}-${Date.now()}.png`);
    try {
      await run("screencapture", [...args, file]);
      return { data: fs.readFileSync(file).toString("base64"), mimeType: "image/png" };
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  // A launchd job outlives the agent and its shell, so the Mac stays awake and unlocked until it is turned off.
  async keepAwake({ on }) {
    if (await keepAwakeIsOn()) await run("launchctl", ["remove", KEEP_AWAKE_LABEL]);
    if (!on) return "Keep-awake is off. The display sleeps and locks on its normal schedule.";
    await run("launchctl", ["submit", "-l", KEEP_AWAKE_LABEL, "--", "/usr/bin/caffeinate", "-d", "-i", "-m", "-s"]);
    return "Keep-awake is on. The display, disks and system stay awake, so the screen does not lock on idle, until you turn it off or log out.";
  }
}
