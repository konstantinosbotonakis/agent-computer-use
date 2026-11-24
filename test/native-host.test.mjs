import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createMessageReader, encodeMessage } from "../src/native-messaging.mjs";

const HOST_SCRIPT = new URL("../src/native-host.mjs", import.meta.url).pathname;

function nextValue(queue) {
  return new Promise((resolve) => {
    if (queue.items.length) resolve(queue.items.shift());
    else queue.waiters.push(resolve);
  });
}

function pushValue(queue, value) {
  if (queue.waiters.length) queue.waiters.shift()(value);
  else queue.items.push(value);
}

async function waitForFile(file) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${file} did not appear`);
}

test("the host routes messages between agents and the extension", async (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "acu-"));
  const host = spawn(process.execPath, [HOST_SCRIPT], { env: { ...process.env, AGENT_COMPUTER_USE_HOME: stateDir } });
  t.after(() => {
    host.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // The test plays the extension: it reads the host's stdout and writes to its stdin.
  const toExtension = { items: [], waiters: [] };
  host.stdout.on("data", createMessageReader((message) => pushValue(toExtension, message)));

  const socketPath = path.join(stateDir, "broker.sock");
  await waitForFile(socketPath);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  const agent = net.createConnection(socketPath);
  const toAgent = { items: [], waiters: [] };
  agent.setEncoding("utf8");
  agent.on("data", (chunk) => chunk.split("\n").filter(Boolean).forEach((line) => pushValue(toAgent, JSON.parse(line))));
  await new Promise((resolve) => agent.once("connect", resolve));

  agent.write(JSON.stringify({ id: 7, op: "ping" }) + "\n");
  const request = await nextValue(toExtension);
  assert.deepEqual(request, { id: 7, op: "ping", agent: 1 });

  host.stdin.write(encodeMessage({ agent: 1, id: 7, result: { version: "test" } }));
  assert.deepEqual(await nextValue(toAgent), { id: 7, result: { version: "test" } });

  host.stdin.write(encodeMessage({ agent: 1, event: "tab.closed", params: { tabId: 3 } }));
  assert.deepEqual(await nextValue(toAgent), { event: "tab.closed", params: { tabId: 3 } });

  agent.end();
  assert.deepEqual(await nextValue(toExtension), { agent: 1, op: "agent.disconnected" });
});
