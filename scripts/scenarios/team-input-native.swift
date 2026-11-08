import AppKit
import ApplicationServices

@_silgen_name("_AXUIElementGetWindow")
func windowNumber(_ element: AXUIElement, _ number: UnsafeMutablePointer<UInt32>) -> AXError

func emit(_ value: [String: Any]) {
	do {
		FileHandle.standardOutput.write(
			try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
		FileHandle.standardOutput.write(Data([10]))
	} catch { fatalError("JSON: \(error)") }
}
func fail(_ message: String) -> Never {
	fputs("\(message)\n", stderr)
	exit(1)
}
func attr(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, key as CFString, &value)
	if result == .attributeUnsupported || result == .noValue { return nil }
	guard result == .success else { fail("AX read \(key): \(result.rawValue)") }
	return value
}
func frame(_ element: AXUIElement) -> [String: Double]? {
	guard let position = attr(element, kAXPositionAttribute),
		let size = attr(element, kAXSizeAttribute),
		CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID()
	else { return nil }
	var point = CGPoint.zero
	var extent = CGSize.zero
	guard AXValueGetValue(unsafeBitCast(position, to: AXValue.self), .cgPoint, &point),
		AXValueGetValue(unsafeBitCast(size, to: AXValue.self), .cgSize, &extent)
	else { return nil }
	return ["x": point.x + extent.width / 2, "y": point.y + extent.height / 2]
}

let args = CommandLine.arguments
guard args.count >= 2 else { fail("mode required") }
switch args[1] {
case "quit":
	guard args.count == 4, let pid = Int32(args[2]) else { fail("quit requires pid and bundle") }
	guard let app = NSRunningApplication(processIdentifier: pid) else {
		emit(["pid": pid, "gone": true])
		exit(0)
	}
	guard app.bundleIdentifier == args[3] else { fail("quit identity mismatch") }
	// Subscribe before terminating. Dedicated fixture processes may contain unsaved documents.
	let observer = NSWorkspace.shared.notificationCenter.addObserver(
		forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
	) { note in
		let terminated = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
		if terminated?.processIdentifier == pid {
			emit(["pid": pid, "gone": NSRunningApplication(processIdentifier: pid) == nil])
			exit(0)
		}
	}
	_ = observer
	app.forceTerminate()
	DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
		fail("owned app did not terminate: \(pid)")
	}
	RunLoop.main.run()
case "launch":
	guard args.count == 4,
		let application = NSWorkspace.shared.urlForApplication(withBundleIdentifier: args[2])
	else { fail("launch requires installed bundle and file") }
	let config = NSWorkspace.OpenConfiguration()
	config.activates = false
	config.createsNewApplicationInstance = true
	config.arguments = [
		"-ApplePersistenceIgnoreState", "YES",
		"-NSAutomaticCapitalizationEnabled", "NO",
		"-NSAutomaticSpellingCorrectionEnabled", "NO",
		"-NSAutomaticQuoteSubstitutionEnabled", "NO",
		"-NSAutomaticDashSubstitutionEnabled", "NO",
	]
	NSWorkspace.shared.open(
		[URL(fileURLWithPath: args[3])], withApplicationAt: application, configuration: config
	) { app, error in
		guard let app = app, error == nil else { fail("launch: \(String(describing: error))") }
		emit(["pid": app.processIdentifier, "bundle": args[2]])
		exit(0)
	}
	RunLoop.main.run()
case "read":
	guard args.count == 6, let pid = Int32(args[2]),
		let running = NSRunningApplication(processIdentifier: pid),
		running.bundleIdentifier == args[3]
	else { fail("read requires exact live pid, bundle, path, button") }
	let app = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(app, 1)
	let windows = attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
	let path = URL(fileURLWithPath: args[4]).resolvingSymlinksInPath().path
	let matches = windows.filter { window in
		guard let document = attr(window, kAXDocumentAttribute) as? String else { return false }
		let candidate =
			document.hasPrefix("file:") ? URL(string: document) : URL(fileURLWithPath: document)
		return candidate?.resolvingSymlinksInPath().path == path
	}
	guard matches.count == 1, let window = matches.first else {
		fail("exact AXDocument window missing or ambiguous")
	}
	var number: UInt32 = 0
	guard windowNumber(window, &number) == .success, number > 0 else { fail("window id missing") }
	var editors: [[String: Any]] = []
	var buttons: [[String: Any]] = []
	var visited = 0
	func walk(_ node: AXUIElement, _ inToolbar: Bool, _ depth: Int) {
		visited += 1
		guard depth < 40, visited < 5000 else { fail("AX tree limit") }
		let role = attr(node, kAXRoleAttribute) as? String ?? ""
		let description = attr(node, kAXRoleDescriptionAttribute) as? String ?? ""
		let toolbar =
			inToolbar || role == kAXToolbarRole || description.lowercased().contains("toolbar")
		let label =
			[
				attr(node, kAXTitleAttribute), attr(node, kAXDescriptionAttribute),
				attr(node, kAXHelpAttribute),
			].compactMap { $0 as? String }.first(where: { !$0.isEmpty }) ?? ""
		if role == kAXTextAreaRole, let text = attr(node, kAXValueAttribute) as? String,
			let point = frame(node)
		{
			editors.append(["text": text, "point": point])
		}
		if [kAXButtonRole, kAXCheckBoxRole, kAXPopUpButtonRole, kAXMenuButtonRole].contains(role),
			let point = frame(node)
		{
			buttons.append(["label": label, "role": role, "toolbar": toolbar, "point": point])
		}
		for child in attr(node, kAXChildrenAttribute) as? [AXUIElement] ?? [] {
			walk(child, toolbar, depth + 1)
		}
	}
	walk(window, false, 0)
	// Never use the file, clipboard, or the driver's success message as the text oracle.
	guard editors.count == 1, let editor = editors.first else {
		fail("exactly one AX text editor required")
	}
	let selected = buttons.filter { ($0["label"] as? String) == args[5] }
	emit([
		"pid": pid, "bundle": args[3], "window_id": number,
		"title": attr(window, kAXTitleAttribute) as? String ?? "",
		"text": editor["text"] ?? "", "editor": editor["point"] ?? [:],
		"buttons": buttons, "button_matches": selected,
	])
case "sample":
	let started = ProcessInfo.processInfo.systemUptime
	var samples: [[String: Any]] = []
	var activations: [[String: Any]] = []
	func sample() {
		guard let point = CGEvent(source: nil)?.location,
			let app = NSWorkspace.shared.frontmostApplication
		else { fail("desktop sample unavailable") }
		samples.append([
			"ms": (ProcessInfo.processInfo.systemUptime - started) * 1000,
			"x": point.x, "y": point.y, "pid": app.processIdentifier,
		])
	}
	let observer = NSWorkspace.shared.notificationCenter.addObserver(
		forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
	) { _ in
		activations.append([
			"ms": (ProcessInfo.processInfo.systemUptime - started) * 1000,
			"pid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? 0,
		])
	}
	sample()
	let timer = Timer(timeInterval: 0.05, repeats: true) { _ in sample() }
	RunLoop.main.add(timer, forMode: .common)
	DispatchQueue.global().async {
		_ = readLine()
		DispatchQueue.main.async {
			sample()
			timer.invalidate()
			NSWorkspace.shared.notificationCenter.removeObserver(observer)
			emit(["samples": samples, "activations": activations])
			exit(0)
		}
	}
	emit(["ready": true, "interval_ms": 50])
	RunLoop.main.run()
default:
	fail("unknown mode")
}
