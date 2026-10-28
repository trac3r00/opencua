import AppKit
import ApplicationServices

// Observation only: never activate Calculator, press a key, or read the clipboard.
func fail(_ message: String) -> Never {
	fputs("Calculator display probe: \(message)\n", stderr)
	exit(1)
}

guard CommandLine.arguments.count == 2,
	let pid = Int32(CommandLine.arguments[1]), pid > 0
else { fail("usage: calculator-display-probe <Calculator pid>") }
guard let running = NSRunningApplication(processIdentifier: pid),
	running.bundleIdentifier == "com.apple.calculator"
else { fail("no Calculator window: PID \(pid) is not a running Calculator") }

let app = AXUIElementCreateApplication(pid)
guard AXUIElementSetMessagingTimeout(app, 2) == .success else { fail("could not set AX timeout") }

func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
	var value: CFTypeRef?
	let status = AXUIElementCopyAttributeValue(element, name as CFString, &value)
	if status == .attributeUnsupported || status == .noValue { return nil }
	guard status == .success else { fail("\(name) read failed: AXError \(status.rawValue)") }
	return value
}

guard let windows = attribute(app, kAXWindowsAttribute) as? [AXUIElement], !windows.isEmpty
else { fail("no Calculator window for PID \(pid)") }
guard windows.count == 1 else { fail("ambiguous Calculator windows: \(windows.count)") }

var visited = 0
var values: [String] = []
func inspect(_ element: AXUIElement, _ depth: Int, _ inDisplay: Bool) {
	guard depth < 20, visited < 512 else { fail("AX traversal limit exceeded") }
	visited += 1
	let identifier = attribute(element, kAXIdentifierAttribute) as? String
	let display = inDisplay || identifier == "StandardInputView"
	if display, attribute(element, kAXRoleAttribute) as? String == kAXStaticTextRole {
		guard let value = attribute(element, kAXValueAttribute) as? String else {
			fail("display has no text value")
		}
		values.append(value)
	}
	if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
		for child in children { inspect(child, depth + 1, display) }
	}
}
inspect(windows[0], 0, false)
guard values.count == 1 else {
	fail("expected one display static text under StandardInputView; found \(values.count)")
}
// SwiftUI prefixes numeric text with direction marks; remove formatting, not digits.
let directionMarks = CharacterSet(charactersIn: "\u{200e}\u{200f}\u{061c}")
let value = String(
	String.UnicodeScalarView(values[0].unicodeScalars.filter { !directionMarks.contains($0) })
)
.trimmingCharacters(in: .whitespacesAndNewlines)
guard !value.isEmpty else { fail("display text is empty") }
print(value)
