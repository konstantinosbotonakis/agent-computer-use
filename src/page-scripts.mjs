// These functions run inside the page through Runtime.evaluate, in an isolated script world
// that the page's own scripts cannot see. Each function must be self-contained because it is
// sent as source text. Element references from the latest snapshot live in
// globalThis.__agentComputerUseRefs inside that isolated world until the page navigates.

export function snapshotPage({ maxLength }) {
  const refs = new Map();
  globalThis.__agentComputerUseRefs = refs;

  const LEAF_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "listbox", "textbox", "searchbox", "slider", "spinbutton", "treeitem", "heading",
    "img", "progressbar", "meter",
  ]);
  const ACTIONABLE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "combobox", "listbox", "textbox", "searchbox", "slider", "spinbutton", "treeitem",
  ]);
  const INPUT_ROLES = {
    button: "button", submit: "button", reset: "button", image: "button", checkbox: "checkbox", radio: "radio",
    range: "slider", number: "spinbutton", search: "searchbox",
  };
  const TAG_ROLES = {
    BUTTON: "button", SUMMARY: "button", TEXTAREA: "textbox", OPTION: "option", NAV: "navigation", MAIN: "main",
    HEADER: "banner", FOOTER: "contentinfo", ASIDE: "complementary", FORM: "form", DIALOG: "dialog",
    TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", UL: "list", OL: "list", LI: "listitem",
    P: "paragraph", IFRAME: "iframe", PROGRESS: "progressbar", METER: "meter",
  };
  const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK"]);

  const clean = (text, limit) => {
    const collapsed = (text ?? "").replace(/\s+/g, " ").trim();
    return collapsed.length > limit ? collapsed.slice(0, limit) + "…" : collapsed;
  };
  const quote = (text) => '"' + text.replace(/"/g, '\\"') + '"';
  const indent = (depth) => "  ".repeat(depth);

  function styleOf(element) {
    return element.ownerDocument.defaultView.getComputedStyle(element);
  }

  function isHidden(element) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return true;
    const style = styleOf(element);
    return style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse";
  }

  function roleOf(element) {
    const explicit = element.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit === "presentation" || explicit === "none") return null;
    if (explicit) return explicit;
    const tag = element.tagName;
    if (tag === "A") return element.hasAttribute("href") ? "link" : null;
    if (/^H[1-6]$/.test(tag)) return "heading";
    if (tag === "INPUT") {
      const type = (element.getAttribute("type") ?? "text").toLowerCase();
      if (type === "hidden") return null;
      return INPUT_ROLES[type] ?? "textbox";
    }
    if (tag === "SELECT") return element.multiple || element.size > 1 ? "listbox" : "combobox";
    if (tag === "IMG") return element.getAttribute("alt") ? "img" : null;
    if (tag === "svg") return element.getAttribute("aria-label") ? "img" : null;
    if (element.isContentEditable && !element.parentElement?.isContentEditable) return "textbox";
    return TAG_ROLES[tag] ?? null;
  }

  function nameOf(element, role) {
    const ariaLabel = element.getAttribute("aria-label");
    if (ariaLabel?.trim()) return clean(ariaLabel, 120);
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (clean(text, 120)) return clean(text, 120);
    }
    if (element.labels?.length) return clean([...element.labels].map((label) => label.innerText).join(" "), 120);
    if (role === "img") return clean(element.getAttribute("alt") ?? element.getAttribute("aria-label"), 120);
    if (["textbox", "searchbox", "combobox", "spinbutton", "listbox"].includes(role)) {
      return clean(element.getAttribute("placeholder") ?? element.getAttribute("title"), 120);
    }
    const text = clean(element.innerText ?? element.textContent, 120);
    if (text) return text;
    const imageAlt = element.querySelector?.("img[alt]")?.getAttribute("alt");
    return clean(imageAlt ?? element.getAttribute("title"), 120);
  }

  function describe(element, role, withRef) {
    let line = "- " + role;
    const name = nameOf(element, role);
    if (name) line += " " + quote(name);
    const attributes = [];
    if (role === "heading") attributes.push("level=" + (element.getAttribute("aria-level") ?? element.tagName.slice(1)));
    if (element.checked === true || element.getAttribute("aria-checked") === "true") attributes.push("checked");
    if (element.selected === true || element.getAttribute("aria-selected") === "true") attributes.push("selected");
    if (element.disabled === true || element.getAttribute("aria-disabled") === "true") attributes.push("disabled");
    const expanded = element.getAttribute("aria-expanded");
    if (expanded) attributes.push(expanded === "true" ? "expanded" : "collapsed");
    if (element.tagName === "SELECT") {
      const chosen = [...element.selectedOptions].map((option) => option.label).join(", ");
      if (chosen) attributes.push("value=" + quote(clean(chosen, 80)));
    } else if (["textbox", "searchbox", "spinbutton", "combobox", "slider"].includes(role) && "value" in element && element.value) {
      attributes.push("value=" + quote(element.type === "password" ? "••••" : clean(element.value, 80)));
    }
    if (role === "link" && element.href) attributes.push("url=" + clean(element.href, 120));
    if (element === element.ownerDocument.activeElement) attributes.push("focused");
    if (withRef) {
      const ref = "e" + (refs.size + 1);
      refs.set(ref, element);
      attributes.push("ref=" + ref);
    }
    return attributes.length ? line + " [" + attributes.join("] [") + "]" : line;
  }

  function childNodesOf(element) {
    if (element.shadowRoot) return [...element.shadowRoot.childNodes];
    if (element.tagName === "SLOT") {
      const assigned = element.assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return [...element.childNodes];
  }

  function isClickable(element, role) {
    if (ACTIONABLE_ROLES.has(role)) return true;
    if (element.hasAttribute("onclick") || (element.hasAttribute("tabindex") && element.tabIndex >= 0)) return true;
    const parent = element.parentElement;
    return styleOf(element).cursor === "pointer" && (!parent || styleOf(parent).cursor !== "pointer");
  }

  // Returns { lines, plain }. A plain subtree has no roles or controls worth listing, so its
  // parent shows it as text.
  function visit(element, depth) {
    if (SKIPPED_TAGS.has(element.tagName) || isHidden(element)) return { lines: [], plain: true, empty: true };
    const role = roleOf(element);
    const clickable = isClickable(element, role);
    if ((role && LEAF_ROLES.has(role)) || (clickable && !role)) {
      return { lines: [indent(depth) + describe(element, role ?? "clickable", clickable)], plain: false };
    }
    if (role === "iframe") {
      let frameDocument = null;
      try {
        frameDocument = element.contentDocument;
      } catch {}
      const header = indent(depth) + "- iframe" + (element.title ? " " + quote(clean(element.title, 80)) : "");
      if (!frameDocument?.body) return { lines: [header + " (cross-origin, not included)"], plain: false };
      const inner = visit(frameDocument.body, depth + 1);
      const innerText = clean(frameDocument.body.innerText, 300);
      return { lines: [header, ...(inner.plain ? (innerText ? [indent(depth + 1) + "- text: " + innerText] : []) : inner.lines)], plain: false };
    }

    const childDepth = role ? depth + 1 : depth;
    const children = [];
    for (const node of childNodesOf(element)) {
      if (node.nodeType === Node.TEXT_NODE) children.push({ plain: true, text: node.textContent });
      else if (node.nodeType === Node.ELEMENT_NODE) children.push({ ...visit(node, childDepth), element: node });
    }

    if (children.every((child) => child.plain)) {
      if (!role) return { lines: [], plain: true };
      const text = clean(element.innerText ?? element.textContent, 300);
      return { lines: [indent(depth) + "- " + role + (text ? ": " + text : "")], plain: false };
    }

    const lines = role ? [indent(depth) + "- " + role] : [];
    let plainRun = [];
    const flushPlainRun = () => {
      const text = clean(plainRun.join(" "), 300);
      if (text) lines.push(indent(childDepth) + "- text: " + text);
      plainRun = [];
    };
    for (const child of children) {
      if (child.plain) {
        if (!child.empty) plainRun.push(child.element ? child.element.innerText ?? child.element.textContent : child.text);
        continue;
      }
      flushPlainRun();
      lines.push(...child.lines);
    }
    flushPlainRun();
    return { lines, plain: false };
  }

  const header = ["Page: " + document.title, "URL: " + location.href, ""];
  const body = document.body;
  let lines = [];
  if (body) {
    const result = visit(body, 0);
    lines = result.plain ? ["- text: " + clean(body.innerText, 2000)] : result.lines;
  }
  let text = header.concat(lines).join("\n");
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "\n[Snapshot truncated at " + maxLength + " characters. Scroll or use evaluate to read the rest.]";
  }
  return { text, refCount: refs.size };
}

export function locateElement({ ref }) {
  const element = globalThis.__agentComputerUseRefs?.get(ref);
  if (!element || !element.isConnected) {
    return { error: "Element " + ref + " is not on the page any more. Take a new snapshot." };
  }
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return { error: "Element " + ref + " has no size on the page, so it cannot be clicked. Use select_option for options of a <select>." };
  }
  const localX = rect.left + rect.width / 2;
  const localY = rect.top + rect.height / 2;
  const hit = element.ownerDocument.elementFromPoint(localX, localY);
  const reachable =
    !hit ||
    element === hit ||
    element.contains(hit) ||
    hit.contains(element) ||
    [...(element.labels ?? [])].some((label) => label.contains(hit));
  if (!reachable) {
    const covering = hit.tagName.toLowerCase() + (hit.id ? "#" + hit.id : "") + (hit.className && typeof hit.className === "string" ? "." + hit.className.trim().split(/\s+/).join(".") : "");
    const text = (hit.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return { error: "Element " + ref + " is covered by <" + covering + ">" + (text ? ' ("' + text + '")' : "") + ". Close or scroll past it first." };
  }
  // Convert from the element's own frame to coordinates of the top-level page.
  let x = localX;
  let y = localY;
  let frameWindow = element.ownerDocument.defaultView;
  while (frameWindow.frameElement) {
    const frameRect = frameWindow.frameElement.getBoundingClientRect();
    x += frameRect.left;
    y += frameRect.top;
    frameWindow = frameWindow.parent;
  }
  return { x, y };
}

export function focusElement({ ref, clear }) {
  const element = globalThis.__agentComputerUseRefs?.get(ref);
  if (!element || !element.isConnected) {
    return { error: "Element " + ref + " is not on the page any more. Take a new snapshot." };
  }
  element.scrollIntoView({ block: "center", behavior: "instant" });
  element.focus();
  const active = element.ownerDocument.activeElement;
  if (active !== element && !element.contains(active)) {
    return { error: "Element " + ref + " cannot take keyboard focus. Click it first or pick an editable element." };
  }
  if (clear) {
    if (typeof element.select === "function") {
      element.select();
    } else if (element.isContentEditable) {
      const range = element.ownerDocument.createRange();
      range.selectNodeContents(element);
      const selection = element.ownerDocument.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return { focused: true };
}

export function selectOptions({ ref, values }) {
  const element = globalThis.__agentComputerUseRefs?.get(ref);
  if (!element || !element.isConnected) {
    return { error: "Element " + ref + " is not on the page any more. Take a new snapshot." };
  }
  if (element.tagName !== "SELECT") return { error: "Element " + ref + " is not a <select>. Click the control and its options instead." };
  const wanted = new Set(values);
  const chosen = [];
  for (const option of element.options) {
    const matches = wanted.has(option.value) || wanted.has(option.label) || wanted.has(option.textContent.trim());
    if (matches) chosen.push(option.label);
    if (matches || element.multiple) option.selected = matches;
  }
  if (!chosen.length) return { error: "None of " + JSON.stringify(values) + " matches an option of " + ref + "." };
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { selected: chosen };
}

export function readPageText() {
  return document.body?.innerText ?? "";
}

export function scrollPage({ pixels }) {
  window.scrollBy(0, pixels);
  return { scrollY: Math.round(window.scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
}

export function describePage() {
  return { title: document.title, url: location.href };
}
