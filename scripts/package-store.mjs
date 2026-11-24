#!/usr/bin/env node
// Builds the .zip to upload to the Chrome Web Store. The store assigns its own extension ID,
// so the upload leaves out the "key" that fixes the ID of the unpacked development build.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(projectDir, "extension");
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
delete manifest.key;

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-computer-use-store-"));
fs.cpSync(extensionDir, stagingDir, { recursive: true, filter: (source) => !source.endsWith(".DS_Store") });
fs.rmSync(path.join(stagingDir, "icons", "icon-512.png"), { force: true });
fs.writeFileSync(path.join(stagingDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

const outputDir = path.join(projectDir, "dist");
const zipPath = path.join(outputDir, `agent-computer-use-extension-${manifest.version}.zip`);
fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-X", "-q", zipPath, "."], { cwd: stagingDir });
fs.rmSync(stagingDir, { recursive: true, force: true });
console.log(`Wrote ${path.relative(projectDir, zipPath)}`);
