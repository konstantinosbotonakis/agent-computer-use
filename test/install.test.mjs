import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const CLI = new URL("../bin/agent-computer-use.mjs", import.meta.url).pathname;

test("install copies the host and extension and registers them with Chrome", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "acu-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const chromeDir = path.join(home, process.platform === "darwin" ? "Library/Application Support/Google/Chrome" : ".config/google-chrome");
  fs.mkdirSync(chromeDir, { recursive: true });
  const stateDir = path.join(home, ".agent-computer-use");
  const env = { ...process.env, HOME: home, AGENT_COMPUTER_USE_HOME: stateDir };

  execFileSync(process.execPath, [CLI, "install"], { env });

  for (const file of ["native-host.mjs", "native-messaging.mjs", "paths.mjs"]) {
    assert.ok(fs.existsSync(path.join(stateDir, "host", file)), `host/${file} was copied`);
  }
  assert.ok(fs.existsSync(path.join(stateDir, "extension", "manifest.json")));
  const launcher = fs.readFileSync(path.join(stateDir, "native-host.sh"), "utf8");
  assert.match(launcher, new RegExp(path.join(stateDir, "host", "native-host.mjs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const manifest = JSON.parse(fs.readFileSync(path.join(chromeDir, "NativeMessagingHosts", "com.agentcomputeruse.host.json"), "utf8"));
  assert.equal(manifest.path, path.join(stateDir, "native-host.sh"));
  assert.deepEqual(manifest.allowed_origins, ["chrome-extension://ihapafjdgdhggebaglklkgenffidmejp/"]);

  execFileSync(process.execPath, [CLI, "uninstall"], { env });
  assert.equal(fs.existsSync(path.join(stateDir, "host")), false);
  assert.equal(fs.existsSync(path.join(chromeDir, "NativeMessagingHosts", "com.agentcomputeruse.host.json")), false);
});
