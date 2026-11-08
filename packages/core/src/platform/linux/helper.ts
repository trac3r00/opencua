/** Embedded so TypeScript builds and package publication cannot omit the Python asset. */
export const LINUX_HELPER = String.raw`
import base64
import ctypes
import ctypes.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import uuid

dependency_error = None
try:
	import gi
	gi.require_version("Atspi", "2.0")
	from gi.repository import Atspi, Gio, GLib
	Atspi.init()
	Atspi.set_timeout(5000, 5000)
except (ImportError, ValueError) as error:
	dependency_error = str(error)


class BackendError(Exception):
	def __init__(self, code, message):
		super().__init__(message)
		self.code = code


def fail(code, message):
	raise BackendError(code, message)


def run(argv):
	if not shutil.which(argv[0]):
		fail("MISSING_DEPENDENCY", "Missing command: " + argv[0])
	try:
		return subprocess.run(argv, check=True, stdout=subprocess.PIPE,
			stderr=subprocess.PIPE, timeout=8).stdout
	except subprocess.TimeoutExpired:
		fail("TIMEOUT", "Command timed out: " + argv[0])
	except subprocess.CalledProcessError as error:
		fail("COMMAND_FAILED", error.stderr.decode("utf-8", errors="replace")[:2048])


def children(node):
	node.clear_cache()
	return [node.get_child_at_index(i) for i in range(node.get_child_count())]


def frame(node):
	component = node.get_component_iface()
	if not component:
		return dict(x=0, y=0, width=0, height=0)
	bounds = component.get_extents(Atspi.CoordType.SCREEN)
	return dict(x=bounds.x, y=bounds.y, width=bounds.width, height=bounds.height)


def live(node):
	if node is None:
		return False
	node.clear_cache()
	return not node.get_state_set().contains(Atspi.StateType.DEFUNCT)


def applications():
	return [node for node in children(Atspi.get_desktop(0)) if live(node)]


def application(pid):
	for node in applications():
		if node.get_process_id() == pid:
			return node
	fail("NO_APP", "No accessible application for pid " + str(pid))


def focused(node):
	return node.get_state_set().contains(Atspi.StateType.ACTIVE)


def app_info(node):
	return dict(name=node.get_name() or "", bundleId="", pid=node.get_process_id(),
		isRunning=True, isFrontmost=focused(node))


def action_names(node):
	action = node.get_action_iface()
	return [action.get_action_name(i) for i in range(action.get_n_actions())] if action else []


snapshots = {}
next_element = 0
window_refs = {}
next_window = 0
session = uuid.uuid4().hex
last_screen_size = None


def accessible_windows(pid):
	global next_window
	result = []
	for node in children(application(pid)):
		if not live(node) or node.get_role_name() not in ("frame", "window", "dialog", "alert"):
			continue
		if not node.get_component_iface():
			continue
		known = next((key for key, value in window_refs.items() if value == node), None)
		if known is None:
			next_window += 1
			known = next_window
			window_refs[known] = node
		result.append(dict(id=known, title=node.get_name() or "", bounds=frame(node)))
	return result


def x_windows(pid):
	# EWMH inventory is read-only: neither activation nor pointer commands are used.
	raw = run(["xprop", "-root", "_NET_CLIENT_LIST"]).decode()
	result = []
	for xid in re.findall(r"0x[0-9a-fA-F]+", raw):
		properties = run(["xprop", "-id", xid, "_NET_WM_PID", "_NET_WM_NAME", "WM_NAME"]).decode()
		owner = re.search(r"_NET_WM_PID.*?=\s*(\d+)", properties)
		if not owner or int(owner.group(1)) != pid:
			continue
		info = run(["xwininfo", "-id", xid]).decode()
		def metric(name):
			found = re.search(re.escape(name) + r":\s*(-?\d+)", info)
			if not found:
				fail("CAPTURE_UNAVAILABLE", "Cannot read X11 window geometry")
			return int(found.group(1))
		title = re.search(r'(?:_NET_WM_NAME|WM_NAME).*?=\s*"(.*)"', properties)
		result.append(dict(id=int(xid, 16), title=title.group(1) if title else "",
			bounds=dict(x=metric("Absolute upper-left X"), y=metric("Absolute upper-left Y"),
				width=metric("Width"), height=metric("Height"))))
	return result


def wayland():
	return bool(os.environ.get("WAYLAND_DISPLAY"))


def windows(pid):
	return accessible_windows(pid) if wayland() else x_windows(pid)


def resolve(ref):
	try:
		snapshot = snapshots.get(ref["pid"])
		if not snapshot or snapshot["id"] != ref["snapshotId"]:
			fail("STALE_REF", "Snapshot expired; observe the application again")
		entry = snapshot["refs"].get(ref["elementId"])
		if not entry:
			fail("STALE_REF", "Element is not in this snapshot")
		node, chain = entry
		if not live(node):
			fail("STALE_REF", "Observed element is defunct")
		# Resolve from the app root and compare AT-SPI object identity at every edge.
		# Never rebind an index to a new object with the same role/name.
		current = application(ref["pid"])
		for index, expected in chain:
			current.clear_cache()
			if index >= current.get_child_count():
				fail("STALE_REF", "Observed element was removed")
			current = current.get_child_at_index(index)
			if current != expected or not live(current):
				fail("STALE_REF", "Observed element was replaced")
		if current != node:
			fail("STALE_REF", "Observed object no longer resolves")
		return node
	except GLib.Error as error:
		fail("STALE_REF", str(error))
	except BackendError as error:
		if error.code == "NO_APP":
			fail("STALE_REF", "Observed application has exited")
		raise


def snapshot(params):
	global next_element
	pid = params["pid"]
	options = params.get("options", {})
	root = application(pid)
	inventory = windows(pid)
	window_id = options.get("windowId")
	selected = next((item for item in inventory if item["id"] == window_id), None)
	if window_id is not None and selected is None:
		fail("NO_WINDOW", "Requested exact window is not available")
	if selected is None and inventory:
		selected = inventory[0]
	if options.get("requireWindow") and selected is None:
		fail("NO_WINDOW", "No application window is available")
	root_chain = []
	if options.get("subtreeOf") is not None:
		previous = snapshots.get(pid)
		ref = dict(pid=pid, snapshotId=previous["id"] if previous else "", elementId=options["subtreeOf"])
		root = resolve(ref)
		root_chain = previous["refs"][options["subtreeOf"]][1]
	elif selected is not None:
		# Bind the tree to the exact inventory window by title AND global geometry.
		matches = [(i, child) for i, child in enumerate(children(root))
			if live(child) and frame(child) == selected["bounds"] and
			(child.get_name() or "") == selected["title"]]
		if len(matches) != 1:
			fail("NO_WINDOW", "Cannot uniquely bind window to its AT-SPI object")
		index, root = matches[0]
		root_chain = [(index, root)]
	refs = {}
	elements = []
	budget = max(1, min(int(options.get("maxElements", 2000)), 20000))
	truncated = False
	def walk(node, chain, depth):
		nonlocal truncated
		global next_element
		if len(elements) >= budget or depth > 100:
			truncated = True
			return None
		if not live(node):
			return None
		next_element += 1
		element_id = next_element
		refs[element_id] = (node, chain)
		text_iface = node.get_text_iface()
		value_iface = node.get_value_iface()
		value = Atspi.Text.get_text(text_iface, 0, -1) if text_iface else (
			str(value_iface.get_current_value()) if value_iface else None)
		entry = dict(id=element_id, role=node.get_role_name(), label=node.get_name() or None,
			value=value, frame=frame(node), actions=action_names(node), children=[])
		elements.append(entry)
		for index in range(node.get_child_count()):
			if len(elements) >= budget:
				truncated = True
				break
			child = node.get_child_at_index(index)
			child_id = walk(child, chain + [(index, child)], depth + 1)
			if child_id is not None:
				entry["children"].append(child_id)
		return element_id
	if options.get("includeAccessibilityTree", True):
		walk(root, root_chain, 0)
	snapshot_id = session + ":" + uuid.uuid4().hex
	if not options.get("probe"):
		snapshots[pid] = dict(id=snapshot_id, refs=refs)
	return dict(app=app_info(application(pid)), windows=inventory, window=selected,
		snapshotId=snapshot_id, elements=elements, truncated=truncated)


def require_success(result):
	if not result:
		fail("UNSUPPORTED_ACTION", "AT-SPI interface declined the operation")
	return True


def semantic(params):
	node = resolve(params["ref"])
	action = params["action"]
	match action:
		case "setValue" | "type":
			editable = node.get_editable_text_iface()
			if editable:
				if action == "type":
					text_iface = node.get_text_iface()
					if not text_iface:
						fail("UNSUPPORTED_ACTION", "EditableText has no Text interface")
					content = params["text"]
					return require_success(editable.insert_text(text_iface.get_caret_offset(),
						content, len(content.encode("utf-8"))))
				return require_success(editable.set_text_contents(params["value"]))
			value = node.get_value_iface()
			if value and action == "setValue":
				return require_success(value.set_current_value(float(params["value"])))
			fail("UNSUPPORTED_ACTION", "Element does not support EditableText/Value")
		case "selectText":
			text_iface = node.get_text_iface()
			if not text_iface:
				fail("UNSUPPORTED_ACTION", "Element does not support Text")
			options = params["options"]
			content = Atspi.Text.get_text(text_iface, 0, -1)
			needle = options.get("text", "")
			prefix = options.get("prefix", "")
			suffix = options.get("suffix", "")
			match_at = content.find(prefix + needle + suffix)
			if match_at < 0:
				fail("TEXT_NOT_FOUND", "Requested text/context is absent")
			start = match_at + len(prefix)
			end = start + len(needle)
			mode = options["selection"]
			if mode != "text":
				return require_success(text_iface.set_caret_offset(start if mode == "before" else end))
			if text_iface.get_n_selections():
				return require_success(text_iface.set_selection(0, start, end))
			return require_success(text_iface.add_selection(start, end))
		case "select":
			parent = node.get_parent()
			selection = parent.get_selection_iface() if parent else None
			if not selection:
				fail("UNSUPPORTED_ACTION", "Parent has no Selection interface")
			return require_success(selection.select_child(node.get_index_in_parent()))
		case "frame":
			return frame(node)
		case _:
			names = action_names(node)
			aliases = {
				"AXPress": ["click", "press", "activate"],
				"click": ["click", "press", "activate"],
				"toggle": ["toggle", "click", "press"],
				"doubleClick": ["double click", "doubleclick"],
				"rightClick": ["show menu", "popup", "context menu"],
			}
			candidates = aliases.get(action, [action])
			for candidate in candidates:
				for index, name in enumerate(names):
					if name.lower() == candidate.lower():
						return require_success(node.get_action_iface().do_action(index))
			fail("UNSUPPORTED_ACTION", "No AT-SPI action " + action + "; available: " + ", ".join(names))


def focused_text(pid, text):
	def find(node, depth):
		if depth > 100 or not live(node):
			return None
		if node.get_state_set().contains(Atspi.StateType.FOCUSED) and node.get_editable_text_iface():
			return node
		for child in children(node):
			found = find(child, depth + 1)
			if found:
				return found
		return None
	node = find(application(pid), 0)
	if not node:
		return False
	iface = node.get_text_iface()
	if not iface:
		return False
	return require_success(node.get_editable_text_iface().insert_text(iface.get_caret_offset(),
		text, len(text.encode("utf-8"))))


def portal_image():
	# Subscribe BEFORE invoking Screenshot, using the protocol's predictable handle token.
	bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
	token = "opencua_" + uuid.uuid4().hex
	sender = bus.get_unique_name().lstrip(":").replace(".", "_")
	path = "/org/freedesktop/portal/desktop/request/" + sender + "/" + token
	loop = GLib.MainLoop()
	response = {}
	def received(connection, sender_name, object_path, interface, signal, parameters):
		code, details = parameters.unpack()
		response.update(code=code, details=details)
		loop.quit()
	subscription = bus.signal_subscribe("org.freedesktop.portal.Desktop",
		"org.freedesktop.portal.Request", "Response", path, None, Gio.DBusSignalFlags.NONE, received)
	def expired():
		response.update(code=2, details={})
		loop.quit()
		return False
	timer = GLib.timeout_add(7000, expired)
	try:
		result = bus.call_sync("org.freedesktop.portal.Desktop", "/org/freedesktop/portal/desktop",
			"org.freedesktop.portal.Screenshot", "Screenshot",
			GLib.Variant("(sa{sv})", ("", {
				"handle_token": GLib.Variant("s", token),
				"interactive": GLib.Variant("b", False),
				"modal": GLib.Variant("b", False)})), None, Gio.DBusCallFlags.NONE, 7000, None)
		if result.unpack()[0] != path:
			fail("CAPTURE_UNAVAILABLE", "Portal returned an unexpected request handle")
		if not response:
			loop.run()
		if response["code"] != 0:
			fail("CAPTURE_UNAVAILABLE", "Screenshot portal denied or timed out; no image available")
		uri = response["details"]["uri"]
		file = Gio.File.new_for_uri(uri)
		ok, data, etag = file.load_contents(None)
		return bytes(data) if ok else fail("CAPTURE_UNAVAILABLE", "Cannot read portal image")
	finally:
		bus.signal_unsubscribe(subscription)
		if GLib.MainContext.default().find_source_by_id(timer):
			GLib.source_remove(timer)


def xrgb_to_rgb(data, width, height, stride, little_endian):
	# 32-bit ZPixmap rows (stride bytes each) to packed RGB; byte order B,G,R,X when little-endian.
	if width <= 0 or height <= 0 or stride < width * 4 or len(data) < stride * height:
		fail("CAPTURE_UNAVAILABLE", "Window image has an unexpected layout")
	blue, green, red = (0, 1, 2) if little_endian else (3, 2, 1)
	out = bytearray(width * height * 3)
	for row in range(height):
		line = data[row * stride:row * stride + width * 4]
		base = row * width * 3
		out[base:base + width * 3:3] = line[red::4]
		out[base + 1:base + width * 3:3] = line[green::4]
		out[base + 2:base + width * 3:3] = line[blue::4]
	return bytes(out)


class XImage(ctypes.Structure):
	_fields_ = [("width", ctypes.c_int), ("height", ctypes.c_int), ("xoffset", ctypes.c_int),
		("format", ctypes.c_int), ("data", ctypes.c_void_p), ("byte_order", ctypes.c_int),
		("bitmap_unit", ctypes.c_int), ("bitmap_bit_order", ctypes.c_int), ("bitmap_pad", ctypes.c_int),
		("depth", ctypes.c_int), ("bytes_per_line", ctypes.c_int), ("bits_per_pixel", ctypes.c_int)]


class XWindowAttributes(ctypes.Structure):
	_fields_ = [("x", ctypes.c_int), ("y", ctypes.c_int), ("width", ctypes.c_int), ("height", ctypes.c_int),
		("border_width", ctypes.c_int), ("depth", ctypes.c_int), ("_rest", ctypes.c_char * 256)]


def composite_window_image(window_id):
	# The window's own composited pixmap: correct when other windows cover it, no subprocess.
	# Returns None when Xcomposite is unavailable so the caller falls back to import.
	x11_name = ctypes.util.find_library("X11")
	composite_name = ctypes.util.find_library("Xcomposite")
	if not x11_name or not composite_name:
		return None
	x11 = ctypes.CDLL(x11_name)
	composite = ctypes.CDLL(composite_name)
	x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
	x11.XOpenDisplay.restype = ctypes.c_void_p
	x11.XGetWindowAttributes.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.POINTER(XWindowAttributes)]
	x11.XGetImage.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint,
		ctypes.c_uint, ctypes.c_ulong, ctypes.c_int]
	x11.XGetImage.restype = ctypes.POINTER(XImage)
	x11.XDestroyImage.argtypes = [ctypes.POINTER(XImage)]
	x11.XFreePixmap.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
	x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
	composite.XCompositeNameWindowPixmap.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
	composite.XCompositeNameWindowPixmap.restype = ctypes.c_ulong
	x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
	display = x11.XOpenDisplay(None)
	if not display:
		return None
	# Xlib's default error handler exits the process; an unredirected window answers BadMatch.
	errors = []
	handler_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p)
	handler = handler_type(lambda _display, _event: errors.append(1) or 0)
	x11.XSetErrorHandler.argtypes = [handler_type]
	x11.XSetErrorHandler.restype = ctypes.c_void_p
	previous = x11.XSetErrorHandler(handler)
	try:
		attributes = XWindowAttributes()
		if not x11.XGetWindowAttributes(display, window_id, ctypes.byref(attributes)) or attributes.depth not in (24, 32):
			return None
		pixmap = composite.XCompositeNameWindowPixmap(display, window_id)
		x11.XSync(display, 0)
		if not pixmap or errors:
			return None
		try:
			image = x11.XGetImage(display, pixmap, 0, 0, attributes.width, attributes.height, 0xFFFFFFFF, 2)
			x11.XSync(display, 0)
			if not image or errors:
				return None
			try:
				frame = image.contents
				if frame.bits_per_pixel != 32:
					return None
				raw = ctypes.string_at(frame.data, frame.bytes_per_line * frame.height)
				return (xrgb_to_rgb(raw, frame.width, frame.height, frame.bytes_per_line, frame.byte_order == 0),
					frame.width, frame.height)
			finally:
				x11.XDestroyImage(image)
		finally:
			x11.XFreePixmap(display, pixmap)
	finally:
		x11.XSync(display, 0)
		x11.XSetErrorHandler(ctypes.cast(previous, handler_type) if previous else handler_type())
		x11.XCloseDisplay(display)


def capture(params):
	global last_screen_size
	options = params.get("options", {})
	window_id = params.get("windowId")
	if wayland():
		if params.get("requireWindow"):
			fail("FULL_SCREEN_ONLY", "Wayland capture is full-screen only; no window-scoped capture available")
		data = run(["grim", "-"]) if shutil.which("grim") else portal_image()
		scope = "screen"
	else:
		data = None
		scope = "window" if window_id is not None else "screen"
	try:
		gi.require_version("GdkPixbuf", "2.0")
		from gi.repository import GdkPixbuf
	except (ImportError, ValueError) as error:
		fail("MISSING_DEPENDENCY", "GdkPixbuf is required to decode captures: " + str(error))
	composited = composite_window_image(int(window_id)) if data is None and window_id is not None else None
	if composited:
		rgb, width, height = composited
		pixels = GdkPixbuf.Pixbuf.new_from_bytes(GLib.Bytes.new(rgb), GdkPixbuf.Colorspace.RGB, False, 8,
			width, height, width * 3)
	else:
		if data is None:
			data = run(["import", "-window", str(window_id) if window_id is not None else "root", "png:-"])
		loader = GdkPixbuf.PixbufLoader.new()
		loader.write(data)
		loader.close()
		pixels = loader.get_pixbuf()
	if not pixels:
		fail("CAPTURE_UNAVAILABLE", "Capture did not contain an image")
	if scope == "screen":
		last_screen_size = dict(width=pixels.get_width(), height=pixels.get_height())
	region = options.get("region")
	if region:
		pixels = pixels.new_subpixbuf(int(region["x"]), int(region["y"]), int(region["width"]), int(region["height"]))
	target = options.get("targetSize")
	if target:
		pixels = pixels.scale_simple(int(target["width"]), int(target["height"]), GdkPixbuf.InterpType.BILINEAR)
	format_name = options.get("format", "png")
	keys = ["quality"] if format_name == "jpeg" else []
	values = [str(options.get("quality", 90))] if keys else []
	ok, encoded = pixels.save_to_bufferv(format_name, keys, values)
	if not ok:
		fail("CAPTURE_UNAVAILABLE", "Cannot encode screenshot")
	return dict(data=base64.b64encode(encoded).decode(), width=pixels.get_width(),
		height=pixels.get_height(), mimeType="image/" + format_name, scope=scope)


KEY_CODES = {
	"escape": 1, "esc": 1, "backspace": 14, "tab": 15, "enter": 28, "return": 28,
	"ctrl": 29, "control": 29, "shift": 42, "alt": 56, "option": 56, "space": 57,
	"home": 102, "up": 103, "pageup": 104, "left": 105, "right": 106, "end": 107,
	"down": 108, "pagedown": 109, "delete": 111, "command": 125, "cmd": 125,
}
for row, start in [("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44), ("1234567890", 2)]:
	KEY_CODES.update({letter: start + i for i, letter in enumerate(row)})


def physical(params):
	if params.get("physical") is not True:
		fail("PHYSICAL_INPUT_REQUIRED", "Physical input requires explicit physical: true")
	method = params["operation"]
	tool = "ydotool" if wayland() else "xdotool"
	def move(position):
		run([tool, "mousemove", "--absolute", "-x", str(position["x"]), "-y", str(position["y"])]
			if wayland() else [tool, "mousemove", "--sync", str(position["x"]), str(position["y"])])
	def button(number, down=None):
		if wayland():
			code = (0xC0 if down is None else 0x40 if down else 0x80) + {1: 0, 2: 2, 3: 1}[number]
			run([tool, "click", hex(code)])
		else:
			run([tool, "click" if down is None else "mousedown" if down else "mouseup", str(number)])
	if params.get("options", {}).get("modifiers"):
		if method != "key":
			fail("UNSUPPORTED_ACTION", "Physical pointer modifiers are not supported; use key explicitly")
	match method:
		case "move":
			move(params["position"])
		case "click" | "rightClick" | "middleClick" | "doubleClick":
			move(params["position"])
			count = 2 if method == "doubleClick" else 1
			for _ in range(count):
				button({"rightClick": 3, "middleClick": 2}.get(method, 1))
		case "type":
			run([tool, "type", "--", params["text"]])
		case "key":
			options = params.get("options", {})
			keys = list(options.get("modifiers", [])) + params["key"].split("+")
			hold = options.get("holdMilliseconds", 0)
			if not math.isfinite(hold) or hold < 0 or hold > 5000:
				fail("INVALID_ARGUMENT", "Key hold must be between 0 and 5000 milliseconds")
			if wayland():
				codes = []
				for key in keys:
					code = KEY_CODES.get(key.lower())
					if code is None:
						fail("UNSUPPORTED_ACTION", "Unknown evdev key: " + key)
					codes.append(code)
				press = [str(code) + ":1" for code in codes]
				release = [str(code) + ":0" for code in reversed(codes)]
				if hold:
					run([tool, "key"] + press)
					try:
						time.sleep(hold / 1000)
					finally:
						run([tool, "key"] + release)
				else:
					run([tool, "key"] + press + release)
			else:
				aliases = {"enter": "Return", "return": "Return", "escape": "Escape", "esc": "Escape",
					"option": "alt", "opt": "alt", "command": "super", "cmd": "super",
					"left": "Left", "right": "Right", "up": "Up", "down": "Down",
					"backspace": "BackSpace", "delete": "Delete", "tab": "Tab"}
				chord = "+".join(aliases.get(key.lower(), key) for key in keys)
				if hold:
					run([tool, "keydown", chord])
					try:
						time.sleep(hold / 1000)
					finally:
						run([tool, "keyup", chord])
				else:
					run([tool, "key", "--clearmodifiers", chord])
		case "scroll":
			options = params["options"]
			if options.get("position"):
				move(options["position"])
			amount = max(0, round(options["amount"]))
			direction = options["direction"]
			if not amount:
				return True
			if wayland():
				delta_x = amount if direction == "right" else -amount if direction == "left" else 0
				delta_y = amount if direction == "up" else -amount if direction == "down" else 0
				run([tool, "mousemove", "--wheel", "-x", str(delta_x), "-y", str(delta_y)])
			else:
				run([tool, "click", "--repeat", str(amount),
					str({"up": 4, "down": 5, "left": 6, "right": 7}[direction])])
		case "drag":
			options = params["options"]
			number = {"left": 1, "middle": 2, "right": 3}.get(options.get("button", "left"), 1)
			duration = options.get("duration", 0)
			if not math.isfinite(duration) or duration < 0 or duration > 5000:
				fail("INVALID_ARGUMENT", "Drag duration must be between 0 and 5000 milliseconds")
			positions = options.get("waypoints", []) + [options["to"]]
			move(options["from"])
			button(number, True)
			try:
				for position in positions:
					if duration:
						time.sleep(duration / len(positions) / 1000)
					move(position)
			finally:
				button(number, False)
		case _:
			fail("UNSUPPORTED_ACTION", "Unknown physical operation")
	return True


def cursor_position():
	if wayland():
		fail("UNSUPPORTED_OPERATION", "Wayland does not expose the global cursor position")
	library = ctypes.util.find_library("X11")
	if not library:
		fail("MISSING_DEPENDENCY", "libX11 is required for pointer queries")
	x11 = ctypes.CDLL(library)
	x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
	x11.XOpenDisplay.restype = ctypes.c_void_p
	x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
	x11.XDefaultRootWindow.restype = ctypes.c_ulong
	x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
	x11.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
		ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
		ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
		ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_uint)]
	display = x11.XOpenDisplay(None)
	if not display:
		fail("NO_DISPLAY", "Cannot open the X11 display")
	try:
		root, child = ctypes.c_ulong(), ctypes.c_ulong()
		x, y, local_x, local_y = ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int()
		mask = ctypes.c_uint()
		ok = x11.XQueryPointer(display, x11.XDefaultRootWindow(display),
			ctypes.byref(root), ctypes.byref(child), ctypes.byref(x), ctypes.byref(y),
			ctypes.byref(local_x), ctypes.byref(local_y), ctypes.byref(mask))
		if not ok:
			fail("NO_DISPLAY", "Pointer is on another X11 screen")
		return dict(x=x.value, y=y.value)
	finally:
		x11.XCloseDisplay(display)


def process_parents():
	parents = {}
	for entry in os.listdir("/proc"):
		if not entry.isdigit():
			continue
		try:
			with open("/proc/" + entry + "/stat") as stat:
				fields = stat.read().rsplit(")", 1)[1].split()
			parents[entry] = int(fields[1])
		except (OSError, IndexError, ValueError):
			continue
	return parents


def audio_report():
	if shutil.which("pw-dump"):
		report = dict(source="pw-dump", text=run(["pw-dump"]).decode())
	elif shutil.which("pactl"):
		report = dict(source="pactl", text=run(["pactl", "--format=json", "list", "sink-inputs"]).decode())
	else:
		fail("MISSING_DEPENDENCY", "Neither pw-dump nor pactl is installed")
	report["parents"] = process_parents()
	return report


def audio_record(params):
	target = params["target"]
	seconds = params["seconds"]
	if (isinstance(target, bool) or not isinstance(target, int) or target < 0
			or isinstance(seconds, bool) or not isinstance(seconds, (int, float)) or not 0 < seconds <= 30):
		fail("INVALID_ARGUMENT", "audioRecord needs a node target and 0 < seconds <= 30")
	if not shutil.which("pw-record"):
		fail("MISSING_DEPENDENCY", "pw-record is not installed")
	path = os.path.join(os.environ.get("XDG_RUNTIME_DIR") or "/tmp", "opencua-audio-" + uuid.uuid4().hex + ".wav")
	try:
		recorder = subprocess.Popen(["pw-record", "--target", str(target), path],
			stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
		try:
			recorder.wait(timeout=seconds)
			fail("CAPTURE_FAILED", "pw-record stopped early: " + recorder.stderr.read().decode(errors="replace")[:200])
		except subprocess.TimeoutExpired:
			recorder.terminate()
			try:
				recorder.wait(timeout=5)
			except subprocess.TimeoutExpired:
				# A recorder that ignores SIGTERM is killed, never left recording.
				recorder.kill()
				recorder.wait()
		with open(path, "rb") as recording:
			return dict(mimeType="audio/wav", data=base64.b64encode(recording.read()).decode())
	finally:
		if os.path.exists(path):
			os.remove(path)


def dispatch(method, params):
	if method == "audio":
		return audio_report()
	if method == "audioRecord":
		return audio_record(params)
	if dependency_error:
		fail("MISSING_DEPENDENCY", "Python GI/AT-SPI unavailable: " + dependency_error)
	match method:
		case "listApps":
			return [app_info(node) for node in applications()]
		case "listWindows":
			return windows(params["pid"])
		case "snapshot":
			return snapshot(params)
		case "act":
			return semantic(params)
		case "focusedType":
			return focused_text(params["pid"], params["text"])
		case "physical":
			return physical(params)
		case "screenshot":
			return capture(params)
		case "cursor":
			return cursor_position()
		case "screenSize":
			if wayland():
				if last_screen_size:
					return last_screen_size
				desktop_bounds = frame(Atspi.get_desktop(0))
				if desktop_bounds["width"] > 0 and desktop_bounds["height"] > 0:
					return dict(width=desktop_bounds["width"], height=desktop_bounds["height"])
				fail("UNSUPPORTED_OPERATION", "Wayland has no display geometry; capture a full screen first")
			raw = run(["xwininfo", "-root"]).decode()
			return dict(width=int(re.search(r"Width:\s*(\d+)", raw).group(1)),
				height=int(re.search(r"Height:\s*(\d+)", raw).group(1)))
		case _:
			fail("UNSUPPORTED_OPERATION", "Unknown Linux helper operation: " + method)


for line in sys.stdin:
	request_id = None
	try:
		request = json.loads(line)
		request_id = request["id"]
		context = GLib.MainContext.default()
		while context.pending():
			context.iteration(False)
		result = dispatch(request["method"], request.get("params", {}))
		reply = dict(id=request_id, result=result)
	except BackendError as error:
		reply = dict(id=request_id, error=dict(code=error.code, message=str(error)))
	except Exception as error:
		# RPC boundary: one failing application must not kill unrelated requests.
		reply = dict(id=request_id, error=dict(code="HELPER_ERROR", message=str(error)))
	print(json.dumps(reply, ensure_ascii=True), flush=True)
`;
