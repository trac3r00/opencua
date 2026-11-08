#!/usr/bin/env python3
# OpenCUA shared surface shell for Linux: a GTK 4 window with a WebKitGTK 6 page and a cursor layer.
# It merges nothing itself: surface-driver.ts runs the shared CursorMux and writes JSON lines on stdin:
#   {"t":"pointer","kind":"down|drag|up|move","x":..,"y":..}  merged page pointer, window points
#   {"t":"mark","tag":..,"x":..,"y":..,"down":bool}           where an agent's cursor is
# Usage: opencua-surface-gtk.py <url> <title> <width> <height> [cursor-names.json]
# GTK 4 has no public way to synthesize input into a widget, so pointer events reach the page as
# DOM PointerEvent/MouseEvent dispatched at the point (isTrusted is false; pages that check it ignore them).
# Run it inside an owned display (owned-session.ts), never on the person's.

import json
import math
import sys
import threading

import gi

gi.require_version("Gtk", "4.0")
gi.require_version("WebKit", "6.0")
from gi.repository import GLib, Gtk, WebKit  # noqa: E402

DISPATCH = """
(function (kind, x, y) {
  const state = (window.__opencua = window.__opencua || { down: false, target: null, moved: false });
  const target = (kind === "drag" || kind === "up") && state.target ? state.target : document.elementFromPoint(x, y);
  if (!target) return;
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1,
    pointerType: "mouse", isPrimary: true, button: 0 };
  const fire = (pointer, mouse, buttons) => {
    target.dispatchEvent(new PointerEvent(pointer, { ...base, buttons }));
    if (mouse) target.dispatchEvent(new MouseEvent(mouse, { ...base, buttons }));
  };
  if (kind === "down") { state.down = true; state.moved = false; state.target = target; fire("pointerdown", "mousedown", 1); }
  else if (kind === "drag") { state.moved = true; fire("pointermove", "mousemove", 1); }
  else if (kind === "up") { fire("pointerup", "mouseup", 0); if (state.down && !state.moved) target.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 })); state.down = false; state.moved = false; state.target = null; }
  else { fire("pointermove", "mousemove", 0); }
})(%s, %f, %f);
"""


def color(hex_text):
	try:
		value = int(hex_text[1:], 16) if isinstance(hex_text, str) and len(hex_text) == 7 else 0xFFFFFF
	except ValueError:
		value = 0xFFFFFF
	return ((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255


class Surface(Gtk.Application):
	def __init__(self, url, title, width, height, names_path):
		super().__init__(application_id=None)
		self.url, self.title, self.size, self.names_path = url, title, (width, height), names_path
		self.marks = {}
		self.names = {}

	def do_activate(self):
		window = Gtk.ApplicationWindow(application=self, title=self.title)
		window.set_default_size(*self.size)
		overlay = Gtk.Overlay()
		self.view = WebKit.WebView()
		self.view.load_uri(self.url)
		overlay.set_child(self.view)
		self.layer = Gtk.DrawingArea()
		self.layer.set_can_target(False)
		self.layer.set_draw_func(self.draw)
		overlay.add_overlay(self.layer)
		window.set_child(overlay)
		window.present()
		GLib.timeout_add(1000, self.reload_names)
		threading.Thread(target=self.read_commands, daemon=True).start()

	def reload_names(self):
		if self.names_path:
			try:
				with open(self.names_path) as names:
					parsed = json.load(names)
				self.names = parsed if isinstance(parsed, dict) else {}
			except (OSError, ValueError):
				pass
			self.layer.queue_draw()
		return True

	def read_commands(self):
		for line in sys.stdin:
			try:
				command = json.loads(line)
			except ValueError:
				continue
			GLib.idle_add(self.apply, command)
		GLib.idle_add(self.quit)

	def apply(self, command):
		if not isinstance(command, dict):
			return False
		if command.get("t") == "init" and isinstance(command.get("scripts"), list):
			manager = self.view.get_user_content_manager()
			for source in command["scripts"]:
				if isinstance(source, str):
					manager.add_script(WebKit.UserScript.new(source, WebKit.UserContentInjectedFrames.TOP_FRAME,
						WebKit.UserScriptInjectionTime.START, None, None))
					self.view.evaluate_javascript(source, -1, None, None, None, None, None)
			return False
		if command.get("t") == "speak" and isinstance(command.get("audio"), str):
			script = "window.__opencuaSpeak && window.__opencuaSpeak(%s)" % json.dumps(command["audio"])
			self.view.evaluate_javascript(script, -1, None, None, None, None, None)
			return False
		x, y = command.get("x"), command.get("y")
		if not all(isinstance(value, (int, float)) and math.isfinite(value) for value in (x, y)):
			return False
		if command.get("t") == "pointer" and command.get("kind") in ("down", "drag", "up", "move"):
			script = DISPATCH % (json.dumps(command["kind"]), x, y)
			self.view.evaluate_javascript(script, -1, None, None, None, None, None)
		elif command.get("t") == "mark" and isinstance(command.get("tag"), int):
			self.marks[str(command["tag"])] = (x, y, command.get("down") is True)
			self.layer.queue_draw()
		return False

	def draw(self, _area, cairo, _width, _height):
		for entry in self.names.values():
			if not isinstance(entry, dict):
				continue
			region = entry.get("region")
			if isinstance(region, dict) and all(isinstance(region.get(k), (int, float)) for k in ("x", "y", "width", "height")):
				if region["width"] > 0 and region["height"] > 0:
					red, green, blue = color(entry.get("color"))
					cairo.set_source_rgba(red, green, blue, 0.12)
					cairo.rectangle(region["x"], region["y"], region["width"], region["height"])
					cairo.fill_preserve()
					cairo.set_source_rgba(red, green, blue, 0.7)
					cairo.set_dash([6, 4])
					cairo.set_line_width(1.5)
					cairo.stroke()
					cairo.set_dash([])
		for key, (x, y, down) in self.marks.items():
			found = self.names.get(key)
			entry = found if isinstance(found, dict) else {}
			red, green, blue = color(entry.get("color"))
			cairo.move_to(x, y)
			cairo.line_to(x, y + 16)
			cairo.line_to(x + 4.5, y + 12)
			cairo.line_to(x + 11, y + 12)
			cairo.close_path()
			cairo.set_source_rgb(red, green, blue)
			cairo.fill_preserve()
			cairo.set_source_rgb(0, 0, 0)
			cairo.set_line_width(2 if down else 1)
			cairo.stroke()
			label = entry.get("name")
			name = label if isinstance(label, str) else "cursor " + key
			badge = entry.get("badge")
			if isinstance(badge, str) and 0 < len(badge) <= 8:
				name = name + " " + badge
			cairo.set_font_size(9)
			cairo.set_source_rgba(red, green, blue, 0.9)
			extents = cairo.text_extents(name)
			cairo.rectangle(x + 10, y + 13, extents.width + 6, 12)
			cairo.fill()
			cairo.set_source_rgb(0, 0, 0)
			cairo.move_to(x + 13, y + 22)
			cairo.show_text(name)


def main(argv):
	if len(argv) < 5:
		print("usage: opencua-surface-gtk.py <url> <title> <width> <height> [cursor-names.json]", file=sys.stderr)
		return 2
	surface = Surface(argv[1], argv[2], int(argv[3]), int(argv[4]), argv[5] if len(argv) > 5 else None)
	return surface.run([argv[0]])


if __name__ == "__main__":
	sys.exit(main(sys.argv))
