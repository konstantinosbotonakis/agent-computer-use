import assert from "node:assert/strict";
import { test } from "node:test";
import { parseKeyCombo } from "../src/keys.mjs";

test("Enter types a carriage return", () => {
  const { keyDown, keyUp } = parseKeyCombo("Enter", "linux");
  assert.equal(keyDown.type, "keyDown");
  assert.equal(keyDown.text, "\r");
  assert.equal(keyDown.windowsVirtualKeyCode, 13);
  assert.equal(keyUp.type, "keyUp");
});

test("a shortcut with Meta sends no text and maps to an editing command on macOS", () => {
  const { keyDown } = parseKeyCombo("Meta+a", "darwin");
  assert.equal(keyDown.type, "rawKeyDown");
  assert.equal(keyDown.text, undefined);
  assert.equal(keyDown.modifiers, 4);
  assert.equal(keyDown.code, "KeyA");
  assert.deepEqual(keyDown.commands, ["selectAll"]);
});

test("Shift alone still types its character", () => {
  const { keyDown } = parseKeyCombo("Shift+A", "linux");
  assert.equal(keyDown.text, "A");
  assert.equal(keyDown.modifiers, 8);
});

test("unknown keys and modifiers are rejected", () => {
  assert.throws(() => parseKeyCombo("Hyper+a"), /Unknown modifier/);
  assert.throws(() => parseKeyCombo("NotAKey"), /Unknown key/);
});
