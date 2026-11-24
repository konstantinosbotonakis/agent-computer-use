import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = new URL("../bin/agent-computer-use.mjs", import.meta.url).pathname;

test("the MCP server lists its tools and explains when Chrome is unreachable", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acu-"));
  const server = spawn(process.execPath, [CLI, "mcp"], { env: { ...process.env, AGENT_COMPUTER_USE_HOME: stateDir } });
  t.after(() => {
    server.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  const responses = new Map();
  let buffered = "";
  server.stdout.setEncoding("utf8");
  server.stdout.on("data", (chunk) => {
    buffered += chunk;
    let newline = buffered.indexOf("\n");
    while (newline >= 0) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      responses.get(message.id)?.(message);
      newline = buffered.indexOf("\n");
    }
  });
  let nextId = 1;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      responses.set(id, resolve);
      server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const { result: listed } = await call("tools/list", {});
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    "click", "console_messages", "evaluate", "handle_dialog", "hover", "navigate", "network_requests", "press_key",
    "screenshot", "scroll", "select_option", "snapshot", "tab_claim", "tab_close", "tab_open", "tabs_list", "type", "wait_for",
  ]);

  const { result: called } = await call("tools/call", { name: "tabs_list", arguments: {} });
  assert.equal(called.isError, true);
  assert.match(called.content[0].text, /not reachable/);
});
