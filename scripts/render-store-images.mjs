#!/usr/bin/env node
// Renders the Chrome Web Store screenshots and promo tile in store/ with headless Chrome.
// Set CHROME to the browser binary when it is not at the default macOS location.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const storeDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "store");
const images = [
  ["screenshot-1-tab-groups", 1280, 800],
  ["screenshot-2-page-outline", 1280, 800],
  ["screenshot-3-control", 1280, 800],
  ["screenshot-4-setup", 1280, 800],
  ["promo-small", 440, 280],
];

for (const [name, width, height] of images) {
  execFileSync(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=8000",
    `--window-size=${width},${height}`,
    `--screenshot=${path.join(storeDir, "images", `${name}.png`)}`,
    `file://${path.join(storeDir, `${name}.html`)}`,
  ], { stdio: "ignore" });
  console.log(`Rendered store/images/${name}.png`);
}
