// Reads and operates macOS apps through the Accessibility API, which keeps working while the
// screen is locked. The MCP server compiles this file on first use and runs it once per command:
//   desktop-helper <command> '<json arguments>'
// It prints one JSON object: {"result": ...} or {"error": "..."}.
import AppKit
import ApplicationServices
import CoreGraphics

struct HelperError: Error { let message: String }

let maxNodes = 1500
let maxValueLength = 200

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func stringAttribute(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let text = value as? String { return text.isEmpty ? nil : text }
  if let number = value as? NSNumber { return number.stringValue }
  return nil
}

func children(_ element: AXUIElement) -> [AXUIElement] {
  return (attribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}

func windows(_ app: AXUIElement) -> [AXUIElement] {
  return (attribute(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []
}

func actionNames(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
  return list
}

// Apps describe custom actions as "Name:Show color panel\nTarget:...\nSelector:...". Only the name is shown.
func displayName(_ action: String) -> String {
  if action.hasPrefix("Name:") { return String(action.dropFirst(5).prefix { $0 != "\n" }) }
  return action.replacingOccurrences(of: "AX", with: "")
}

// Keeps each element on one line of the outline.
func oneLine(_ text: String) -> String {
  return text.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\"", with: "\\\"")
}

func screenIsLocked() -> Bool {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (session?["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func requireAccessibility() throws {
  if !AXIsProcessTrusted() {
    throw HelperError(message: "macOS has not given Accessibility access to the app that runs your agent. Allow it in System Settings > Privacy & Security > Accessibility, then restart the agent.")
  }
}

// Finds a running app by name, bundle identifier or process id.
func findApp(_ query: String) throws -> NSRunningApplication {
  let apps = NSWorkspace.shared.runningApplications
  if let pid = Int32(query), let app = apps.first(where: { $0.processIdentifier == pid }) { return app }
  if let app = apps.first(where: { $0.bundleIdentifier?.lowercased() == query.lowercased() }) { return app }
  if let app = apps.first(where: { $0.localizedName?.lowercased() == query.lowercased() }) { return app }
  throw HelperError(message: "No running app matches \"\(query)\". Use desktop_apps to list running apps, or desktop_open to start one.")
}

func staleReference(_ ref: String) -> HelperError {
  return HelperError(message: "Reference \"\(ref)\" does not exist any more. Take a new desktop_snapshot.")
}

// A reference is a path of child indexes from a window ("w0.3.1") or from the menu bar ("m.2.0").
func resolve(_ app: AXUIElement, _ ref: String) throws -> AXUIElement {
  var parts = ref.split(separator: ".").map(String.init)
  guard let head = parts.first else { throw staleReference(ref) }
  parts.removeFirst()
  var element: AXUIElement
  let appWindows = windows(app)
  if head == "m", let menuBar = attribute(app, kAXMenuBarAttribute) {
    element = menuBar as! AXUIElement
  } else if head.hasPrefix("w"), let index = Int(head.dropFirst()), index < appWindows.count {
    element = appWindows[index]
  } else {
    throw staleReference(ref)
  }
  for part in parts {
    let list = children(element)
    guard let index = Int(part), index < list.count else { throw staleReference(ref) }
    element = list[index]
  }
  return element
}

func describe(_ element: AXUIElement, ref: String, depth: Int, into lines: inout [String], count: inout Int) {
  if count >= maxNodes { return }
  count += 1
  let role = (stringAttribute(element, kAXRoleAttribute) ?? "Unknown").replacingOccurrences(of: "AX", with: "")
  let label = (stringAttribute(element, kAXTitleAttribute) ?? stringAttribute(element, kAXDescriptionAttribute)).map(oneLine)
  var value = stringAttribute(element, kAXValueAttribute).map(oneLine)
  if let text = value, text.count > maxValueLength { value = String(text.prefix(maxValueLength)) + "…" }
  let hidden: Set<String> = ["AXScrollToVisible", "AXShowDefaultUI", "AXShowAlternateUI", "AXCancel", "AXPick"]
  let actions = actionNames(element).filter { !hidden.contains($0) }
  // Untitled groups that do nothing only add depth, so their children are listed in their place.
  let structural: Set<String> = ["Group", "SplitGroup", "ScrollArea", "LayoutArea", "Unknown"]
  let skip = structural.contains(role) && label == nil && value == nil && actions.isEmpty
  if !skip {
    var line = String(repeating: "  ", count: depth) + "- " + role
    if let label = label { line += " \"\(label)\"" }
    if let value = value { line += " value=\"\(value)\"" }
    if (attribute(element, kAXEnabledAttribute) as? Bool) == false { line += " disabled" }
    if (attribute(element, kAXFocusedAttribute) as? Bool) == true { line += " focused" }
    if !actions.isEmpty { line += " actions=" + actions.map(displayName).joined(separator: ",") }
    lines.append(line + " [ref=\(ref)]")
  }
  for (index, child) in children(element).enumerated() {
    describe(child, ref: "\(ref).\(index)", depth: skip ? depth : depth + 1, into: &lines, count: &count)
  }
}

func status() -> [String: Any] {
  return ["screenLocked": screenIsLocked(), "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()]
}

func listApps() throws -> [[String: Any]] {
  try requireAccessibility()
  return NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map { app in
    var info: [String: Any] = ["name": app.localizedName ?? "", "pid": app.processIdentifier, "active": app.isActive, "hidden": app.isHidden]
    if let bundle = app.bundleIdentifier { info["bundleId"] = bundle }
    info["windows"] = windows(AXUIElementCreateApplication(app.processIdentifier)).map { stringAttribute($0, kAXTitleAttribute) ?? "" }
    return info
  }
}

func snapshot(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  let app = try findApp(args["app"] as? String ?? "")
  let element = AXUIElementCreateApplication(app.processIdentifier)
  var lines = ["App: \(app.localizedName ?? "") (pid \(app.processIdentifier))"]
  if screenIsLocked() { lines.append("The screen is locked. Reading, actions, menus and set_value still work; typing, keys and screenshots do not.") }
  var count = 0
  let appWindows = windows(element)
  if appWindows.isEmpty { lines.append("The app has no open windows.") }
  for (index, window) in appWindows.enumerated() {
    describe(window, ref: "w\(index)", depth: 0, into: &lines, count: &count)
  }
  if (args["menus"] as? Bool) == true, let menuBar = attribute(element, kAXMenuBarAttribute) {
    describe(menuBar as! AXUIElement, ref: "m", depth: 0, into: &lines, count: &count)
  }
  if count >= maxNodes { lines.append("(Stopped after \(maxNodes) elements.)") }
  return lines.joined(separator: "\n")
}

func perform(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  let app = try findApp(args["app"] as? String ?? "")
  let ref = args["ref"] as? String ?? ""
  let element = try resolve(AXUIElementCreateApplication(app.processIdentifier), ref)
  let available = actionNames(element)
  let requested = args["action"] as? String ?? "Press"
  // Matches the names shown in the snapshot, with or without the AX prefix.
  guard let action = available.first(where: { $0 == requested || displayName($0).lowercased() == requested.lowercased() }) else {
    let offered = available.map(displayName).joined(separator: ", ")
    throw HelperError(message: "\(ref) has no \(requested) action. It offers: \(offered.isEmpty ? "none" : offered).")
  }
  let result = AXUIElementPerformAction(element, action as CFString)
  guard result == .success else { throw HelperError(message: "\(requested) on \(ref) failed (AXError \(result.rawValue)).") }
  return "Performed \(requested) on \(ref)."
}

// Commands that act on the selection are disabled while their app is in the background.
func requireEnabled(_ item: AXUIElement, _ name: String) throws {
  if (attribute(item, kAXEnabledAttribute) as? Bool) == false {
    throw HelperError(message: "\(name) is disabled right now. If the app is in the background, bring it to the front with desktop_focus and try again.")
  }
}

func setValue(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  let app = try findApp(args["app"] as? String ?? "")
  let ref = args["ref"] as? String ?? ""
  let element = try resolve(AXUIElementCreateApplication(app.processIdentifier), ref)
  AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
  let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, (args["value"] as? String ?? "") as CFString)
  guard result == .success else { throw HelperError(message: "Setting the value of \(ref) failed (AXError \(result.rawValue)). The element may not be editable.") }
  return "Set the value of \(ref)."
}

// Presses a menu item by its titles, for example ["File", "New Window"], without opening the menu.
func menu(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  let app = try findApp(args["app"] as? String ?? "")
  let titles = args["path"] as? [String] ?? []
  guard !titles.isEmpty else { throw HelperError(message: "Give the menu path, for example [\"File\", \"New Window\"].") }
  guard let menuBar = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXMenuBarAttribute) else {
    throw HelperError(message: "The app has no menu bar.")
  }
  var current = menuBar as! AXUIElement
  for title in titles {
    // Menu bar items and submenu items hold their entries inside an AXMenu child.
    let candidates = children(current).flatMap { child -> [AXUIElement] in
      stringAttribute(child, kAXRoleAttribute) == kAXMenuRole ? children(child) : [child]
    }
    guard let match = candidates.first(where: { stringAttribute($0, kAXTitleAttribute)?.lowercased() == title.lowercased() }) else {
      let available = candidates.compactMap { stringAttribute($0, kAXTitleAttribute) }
      throw HelperError(message: "No menu item \"\(title)\". Available: \(available.joined(separator: ", ")).")
    }
    current = match
  }
  try requireEnabled(current, titles.joined(separator: " > "))
  let result = AXUIElementPerformAction(current, kAXPressAction as CFString)
  guard result == .success else { throw HelperError(message: "Pressing \(titles.joined(separator: " > ")) failed (AXError \(result.rawValue)).") }
  return "Pressed \(titles.joined(separator: " > "))."
}

let keyCodes: [String: CGKeyCode] = [
  "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
  "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
  "left": 123, "arrowleft": 123, "right": 124, "arrowright": 124, "down": 125, "arrowdown": 125, "up": 126, "arrowup": 126,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29,
  "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "meta": .maskCommand, "shift": .maskShift,
  "alt": .maskAlternate, "option": .maskAlternate, "ctrl": .maskControl, "control": .maskControl,
]

// Apps only act on Enter, Tab and similar keys posted to their process when the event carries the
// character, the same way desktop_type sends text.
let keyCharacters: [String: String] = ["return": "\r", "enter": "\r", "tab": "\t", "space": " ", "escape": "\u{1b}", "esc": "\u{1b}", "delete": "\u{7f}", "backspace": "\u{7f}"]

func requireUnlockedForInput() throws {
  if screenIsLocked() {
    throw HelperError(message: "The screen is locked, and macOS does not deliver keyboard input while it is. Use desktop_set_value, desktop_action or desktop_menu instead.")
  }
}

// Finds the menu item that owns a keyboard shortcut, searching submenus a few levels deep.
// AXMenuItemCmdModifiers: 1 Shift, 2 Option, 4 Control, 8 means Command is not part of it.
func menuItem(in element: AXUIElement, character: String, modifiers: Int, depth: Int = 0) -> AXUIElement? {
  if depth > 4 { return nil }
  for child in children(element) {
    if stringAttribute(child, kAXRoleAttribute) == kAXMenuItemRole,
       stringAttribute(child, kAXMenuItemCmdCharAttribute)?.lowercased() == character,
       (attribute(child, kAXMenuItemCmdModifiersAttribute) as? Int ?? 0) == modifiers {
      return child
    }
    if let found = menuItem(in: child, character: character, modifiers: modifiers, depth: depth + 1) { return found }
  }
  return nil
}

// Shortcuts run through the menu item that owns them, which works in the background and while the
// screen is locked. Other keys are posted to the app's process, so the app does not need to be in front.
func pressKey(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  let app = try findApp(args["app"] as? String ?? "")
  let key = args["key"] as? String ?? ""
  let combo = key.lowercased().split(separator: "+").map(String.init)
  guard let keyName = combo.last, let code = keyCodes[keyName] else {
    throw HelperError(message: "Unknown key \"\(key)\". Use names like Enter, Escape, Tab, ArrowDown, F5 or Cmd+N.")
  }
  var flags = CGEventFlags()
  for name in combo.dropLast() {
    guard let flag = modifierFlags[name] else { throw HelperError(message: "Unknown modifier \"\(name)\". Use Cmd, Shift, Alt or Ctrl.") }
    flags.insert(flag)
  }
  if flags.contains(.maskCommand), let menuBar = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXMenuBarAttribute) {
    let modifiers = (flags.contains(.maskShift) ? 1 : 0) | (flags.contains(.maskAlternate) ? 2 : 0) | (flags.contains(.maskControl) ? 4 : 0)
    if let item = menuItem(in: menuBar as! AXUIElement, character: keyName, modifiers: modifiers) {
      let title = stringAttribute(item, kAXTitleAttribute) ?? "menu command"
      try requireEnabled(item, "\(key) (\(title))")
      let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
      guard result == .success else { throw HelperError(message: "\(key) (\(title)) failed (AXError \(result.rawValue)).") }
      return "Pressed \(key) (\(title)) in \(app.localizedName ?? "the app")."
    }
  }
  try requireUnlockedForInput()
  let shortcut = !flags.intersection([.maskCommand, .maskControl, .maskAlternate]).isEmpty
  if !shortcut, var character = keyCharacters[keyName] ?? (keyName.count == 1 ? keyName : nil) {
    if flags.contains(.maskShift) { character = character.uppercased() }
    postText(character, to: app.processIdentifier)
    return "Pressed \(key) in \(app.localizedName ?? "the app")."
  }
  for keyDown in [true, false] {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: keyDown)!
    event.flags = flags
    event.postToPid(app.processIdentifier)
  }
  return "Pressed \(key) in \(app.localizedName ?? "the app")."
}

func postText(_ text: String, to pid: pid_t) {
  for character in text {
    let units = Array(String(character).utf16)
    for keyDown in [true, false] {
      let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: keyDown)!
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      event.postToPid(pid)
    }
    usleep(4000)
  }
}

func typeText(_ args: [String: Any]) throws -> String {
  try requireAccessibility()
  try requireUnlockedForInput()
  let app = try findApp(args["app"] as? String ?? "")
  let text = args["text"] as? String ?? ""
  postText(text, to: app.processIdentifier)
  return "Typed \(text.count) characters into \(app.localizedName ?? "the app")."
}

// On-screen window ids of an app, front to back, for screencapture -l.
func windowIds(_ args: [String: Any]) throws -> [[String: Any]] {
  let app = try findApp(args["app"] as? String ?? "")
  let info = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  return info
    .filter { ($0[kCGWindowOwnerPID as String] as? Int32) == app.processIdentifier && ($0[kCGWindowLayer as String] as? Int) == 0 }
    .map { ["id": $0[kCGWindowNumber as String] ?? 0, "title": $0[kCGWindowName as String] ?? ""] }
}

// Waits up to three seconds for the app to become the front app after it was asked to activate.
func waitFront(_ args: [String: Any]) throws -> String {
  let app = try findApp(args["app"] as? String ?? "")
  for _ in 0..<30 {
    if NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier { return "\(app.localizedName ?? "The app") is now the front app." }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
  }
  let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "another app"
  throw HelperError(message: "\(app.localizedName ?? "The app") did not come to the front; \(front) is still in front. A system dialog may be open: check desktop_apps or take a desktop_screenshot.")
}

let commandLine = CommandLine.arguments
let command = commandLine.count > 1 ? commandLine[1] : ""
let input = commandLine.count > 2 ? commandLine[2] : "{}"
do {
  guard let args = try JSONSerialization.jsonObject(with: input.data(using: .utf8)!) as? [String: Any] else {
    throw HelperError(message: "Arguments must be a JSON object.")
  }
  let result: Any
  switch command {
  case "status": result = status()
  case "apps": result = try listApps()
  case "snapshot": result = try snapshot(args)
  case "action": result = try perform(args)
  case "set_value": result = try setValue(args)
  case "menu": result = try menu(args)
  case "press_key": result = try pressKey(args)
  case "type": result = try typeText(args)
  case "windows": result = try windowIds(args)
  case "wait_front": result = try waitFront(args)
  default: throw HelperError(message: "Unknown command \"\(command)\".")
  }
  emit(["result": result])
} catch let error as HelperError {
  emit(["error": error.message])
} catch {
  emit(["error": "\(error)"])
}
