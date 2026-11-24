// Turns key descriptions such as "Enter", "a" or "Meta+Shift+z" into DevTools
// Input.dispatchKeyEvent parameters.

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const NAMED_KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Space: { key: " ", code: "Space", keyCode: 32, text: " " },
};
for (let number = 1; number <= 12; number++) {
  NAMED_KEYS["F" + number] = { code: "F" + number, keyCode: 111 + number };
}

// Chrome on macOS runs editing shortcuts through these commands rather than key events.
const MAC_EDITING_COMMANDS = {
  "Meta+a": "selectAll",
  "Meta+c": "copy",
  "Meta+x": "cut",
  "Meta+v": "paste",
  "Meta+z": "undo",
  "Meta+Shift+z": "redo",
};

function describeCharacter(character) {
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) return { code: "Key" + upper, keyCode: upper.charCodeAt(0) };
  if (/^[0-9]$/.test(character)) return { code: "Digit" + character, keyCode: character.charCodeAt(0) };
  return { code: "", keyCode: 0 };
}

export function parseKeyCombo(combo, platform = process.platform) {
  const parts = combo === "+" ? ["+"] : combo.split("+");
  const keyName = parts.pop();
  let modifiers = 0;
  for (const modifier of parts) {
    if (!(modifier in MODIFIER_BITS)) throw new Error(`Unknown modifier "${modifier}" in "${combo}".`);
    modifiers |= MODIFIER_BITS[modifier];
  }

  let definition;
  if (keyName in NAMED_KEYS) {
    definition = { key: keyName, ...NAMED_KEYS[keyName] };
  } else if ([...keyName].length === 1) {
    definition = { key: keyName, text: keyName, ...describeCharacter(keyName) };
  } else {
    throw new Error(`Unknown key "${keyName}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(", ")}.`);
  }

  // Shortcuts with Control, Alt or Meta do not type their character.
  const typesText = definition.text !== undefined && (modifiers & ~MODIFIER_BITS.Shift) === 0;
  const keyDown = {
    type: typesText ? "keyDown" : "rawKeyDown",
    modifiers,
    key: definition.key,
    code: definition.code,
    windowsVirtualKeyCode: definition.keyCode,
  };
  if (typesText) {
    keyDown.text = definition.text;
    keyDown.unmodifiedText = definition.text;
  }
  const command = platform === "darwin" ? MAC_EDITING_COMMANDS[combo] : undefined;
  if (command) keyDown.commands = [command];

  const keyUp = { type: "keyUp", modifiers, key: definition.key, code: definition.code, windowsVirtualKeyCode: definition.keyCode };
  return { keyDown, keyUp };
}
