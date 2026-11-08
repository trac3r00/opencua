import { describe, expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { LinuxHelperClient, spawnLinuxHelper } from "./client.js";
import { LINUX_HELPER } from "./helper.js";

const execute = promisify(execFile);

// Execute the shipped Python implementation against in-memory GI objects.
// No Linux session, D-Bus service, pointer, files, or real AT-SPI are used.
const fakeGi = String.raw`
import sys
import types
import json

class States:
	def __init__(self, node):
		self.node = node
	def contains(self, state):
		return state in self.node.states

class Node:
	def __init__(self, name, role, kids=None, actions=None, editable=False):
		self.name, self.role = name, role
		self.kids = kids or []
		self.actions = actions or []
		self.editable = editable
		self.states = set()
		self.value = "hello world"
		self.performed = []
		self.selection = None
		self.caret = 5
		self.parent = None
		for kid in self.kids:
			kid.parent = self
	def get_child_count(self): return len(self.kids)
	def clear_cache(self): pass
	def get_child_at_index(self, index): return self.kids[index]
	def get_process_id(self): return 17
	def get_name(self): return self.name
	def get_role_name(self): return self.role
	def get_state_set(self): return States(self)
	def get_component_iface(self): return self
	def get_extents(self, coord): return types.SimpleNamespace(x=100, y=200, width=800, height=600)
	def get_action_iface(self): return self if self.actions else None
	def get_n_actions(self): return len(self.actions)
	def get_action_name(self, index): return self.actions[index]
	def do_action(self, index):
		self.performed.append(self.actions[index])
		return True
	def get_text_iface(self): return self if self.editable else None
	def get_editable_text_iface(self): return self if self.editable else None
	def get_value_iface(self): return None
	# Accessible.get_text is the deprecated interface getter, NOT Text.get_text.
	def get_text(self): return self.get_text_iface()
	def get_caret_offset(self): return self.caret
	def set_text_contents(self, value):
		self.value = value
		return True
	def insert_text(self, offset, value, length):
		self.value = self.value[:offset] + value + self.value[offset:]
		return True
	def set_caret_offset(self, offset):
		self.caret = offset
		return True
	def get_n_selections(self): return 0 if self.selection is None else 1
	def add_selection(self, start, end):
		self.selection = [start, end]
		return True
	def set_selection(self, index, start, end): return self.add_selection(start, end)
	def get_parent(self): return self.parent
	def get_index_in_parent(self): return self.parent.kids.index(self)
	def get_selection_iface(self): return self
	def select_child(self, index):
		self.selection = index
		return True

control = Node("Field", "text", actions=["click", "toggle", "scroll down"], editable=True)
window_node = Node("Document", "frame", [control])
app_node = Node("Editor", "application", [window_node])
desktop = Node("Desktop", "desktop", [app_node])
app_node.states.add("active")
control.states.add("focused")
gi_module = types.ModuleType("gi")
gi_module.require_version = lambda *args: None
repository = types.ModuleType("gi.repository")
repository.Atspi = types.SimpleNamespace(init=lambda: None, set_timeout=lambda *args: None,
	get_desktop=lambda index: desktop,
	Text=types.SimpleNamespace(get_text=lambda node, start, end: node.value),
	CoordType=types.SimpleNamespace(SCREEN=0),
	StateType=types.SimpleNamespace(ACTIVE="active", FOCUSED="focused", DEFUNCT="defunct"))
repository.Gio = types.SimpleNamespace()
repository.GLib = types.SimpleNamespace(Error=RuntimeError)
gi_module.repository = repository
sys.modules["gi"] = gi_module
sys.modules["gi.repository"] = repository
`;

const setup = String.raw`
os.environ["WAYLAND_DISPLAY"] = "fixture-wayland"
commands = []
def fake_run(argv):
	commands.append(argv)
	return b""
run = fake_run
state = snapshot(dict(pid=17, options={}))
ref = dict(pid=17, snapshotId=state["snapshotId"], elementId=state["elements"][1]["id"])
`;

async function python(scenario: string): Promise<unknown> {
	const definitions = LINUX_HELPER.split("\nfor line in sys.stdin:")[0];
	if (!definitions) throw new Error("Missing helper definitions");
	const script = `${fakeGi}\nexec(${JSON.stringify(definitions)})\n${setup}\n${scenario}`;
	const { stdout } = await execute("python3", ["-c", script], { timeout: 5000 });
	return JSON.parse(stdout);
}

describe("shipped Python semantic implementation", () => {
	it("#given the shipped helper source #when parsed with the Python 3.8 grammar #then it has no newer syntax", async () => {
		const parse = `import ast, sys\nast.parse(sys.stdin.read(), feature_version=(3, 8))\nprint("null")`;
		const child = execute("python3", ["-c", parse], { timeout: 5000 });
		child.child.stdin?.end(LINUX_HELPER);
		const { stdout } = await child;
		expect(stdout.trim()).toBe("null");
	}, 30_000);

	it("#given AT-SPI EditableText #when set-value and typing run #then edits the exact accessible without physical commands", async () => {
		const result = await python(String.raw`
semantic(dict(ref=ref, action="setValue", value="start"))
control.caret = 5
semantic(dict(ref=ref, action="type", text="!"))
semantic(dict(ref=ref, action="toggle"))
semantic(dict(ref=ref, action="select"))
print(json.dumps(dict(value=control.value, actions=control.performed,
	selection=window_node.selection, commands=commands)))
`);
		expect(result).toEqual({ value: "start!", actions: ["toggle"], selection: 0, commands: [] });
	}, 30_000);

	it("#given text context #when selection and caret actions run #then uses character offsets without focus changes", async () => {
		const result = await python(String.raw`
semantic(dict(ref=ref, action="selectText", options=dict(selection="text", text="world", prefix="hello ")))
selection = control.selection
semantic(dict(ref=ref, action="selectText", options=dict(selection="before", text="world")))
print(json.dumps(dict(selection=selection, caret=control.caret, commands=commands)))
`);
		expect(result).toEqual({ selection: [6, 11], caret: 6, commands: [] });
	}, 30_000);

	it.each(["removed", "replaced", "defunct", "new-snapshot", "app-exited"])(
		"#given an observed element #when %s #then refuses STALE_REF rather than acting on a replacement",
		async (scenario) => {
			const result = await python(String.raw`
scenario = ${JSON.stringify(scenario)}
if scenario == "removed":
	window_node.kids.clear()
elif scenario == "replaced":
	window_node.kids[0] = Node("Field", "text", actions=["click"], editable=True)
elif scenario == "defunct":
	control.states.add("defunct")
elif scenario == "new-snapshot":
	snapshot(dict(pid=17, options={}))
elif scenario == "app-exited":
	desktop.kids.clear()
try:
	semantic(dict(ref=ref, action="click"))
	result = "incorrectly acted"
except BackendError as error:
	result = error.code
print(json.dumps(dict(result=result, performed=control.performed, commands=commands)))
`);
			expect(result).toEqual({ result: "STALE_REF", performed: [], commands: [] });
		},
	);

	it("#given an existing focused text object #when focusedType runs #then inserts via EditableText only", async () => {
		expect(
			await python(String.raw`
focused_text(17, "!")
print(json.dumps(dict(value=control.value, commands=commands)))
`),
		).toEqual({ value: "hello! world", commands: [] });
	}, 30_000);

	it("#given no physical opt-in #when physical commands reach Python #then independently rejects before invoking tools", async () => {
		expect(
			await python(String.raw`
try:
	physical(dict(operation="click", position=dict(x=1, y=2)))
	result = "incorrectly acted"
except BackendError as error:
	result = error.code
print(json.dumps(dict(result=result, commands=commands)))
`),
		).toEqual({ result: "PHYSICAL_INPUT_REQUIRED", commands: [] });
	}, 30_000);

	it.each(["x11", "wayland"])(
		"#given explicit physical input on %s #when clicking #then uses the matching tool without window activation",
		async (sessionType) => {
			const result = await python(String.raw`
if ${JSON.stringify(sessionType)} == "x11":
	os.environ.pop("WAYLAND_DISPLAY", None)
physical(dict(operation="click", physical=True, position=dict(x=12, y=34)))
print(json.dumps(commands))
`);
			if (sessionType === "x11") {
				expect(result).toEqual([
					["xdotool", "mousemove", "--sync", "12", "34"],
					["xdotool", "click", "1"],
				]);
			} else {
				expect(result).toEqual([
					["ydotool", "mousemove", "--absolute", "-x", "12", "-y", "34"],
					["ydotool", "click", "0xc0"],
				]);
			}
		},
	);

	it("#given a numeric Value interface #when setValue runs #then uses its setter rather than keyboard input", async () => {
		expect(
			await python(String.raw`
control.editable = False
class NumericValue:
	current = 0
	def set_current_value(self, value):
		self.current = value
		return True
numeric = NumericValue()
control.get_value_iface = lambda: numeric
semantic(dict(ref=ref, action="setValue", value="42.5"))
print(json.dumps(dict(value=numeric.current, commands=commands)))
`),
		).toEqual({ value: 42.5, commands: [] });
	}, 30_000);

	it("#given an unsupported semantic action #when requested #then fails without synthetic fallback", async () => {
		expect(
			await python(String.raw`
try:
	semantic(dict(ref=ref, action="middleClick"))
	result = "incorrectly acted"
except BackendError as error:
	result = error.code
print(json.dumps(dict(result=result, commands=commands)))
`),
		).toEqual({ result: "UNSUPPORTED_ACTION", commands: [] });
	}, 30_000);

	it.each([
		["up", "0", "2"],
		["down", "0", "-2"],
		["left", "-2", "0"],
		["right", "2", "0"],
	])(
		"#given Wayland physical opt-in #when scrolling %s #then emits both wheel axes with evdev direction",
		async (direction, x, y) => {
			expect(
				await python(String.raw`
physical(dict(operation="scroll", physical=True, options=dict(direction=${JSON.stringify(direction)}, amount=2)))
print(json.dumps(commands))
`),
			).toEqual([["ydotool", "mousemove", "--wheel", "-x", x, "-y", y]]);
		},
	);

	it("#given a held key #when physical key input runs #then releases every modifier after the injected duration", async () => {
		expect(
			await python(String.raw`
pauses = []
time.sleep = pauses.append
physical(dict(operation="key", physical=True, key="enter",
	options=dict(modifiers=["ctrl"], holdMilliseconds=120)))
print(json.dumps(dict(pauses=pauses, commands=commands)))
`),
		).toEqual({
			pauses: [0.12],
			commands: [
				["ydotool", "key", "29:1", "28:1"],
				["ydotool", "key", "28:0", "29:0"],
			],
		});
	}, 30_000);

	it("#given a failed drag movement #when physical drag runs #then releases its button in the failure path", async () => {
		expect(
			await python(String.raw`
def failing_run(argv):
	commands.append(argv)
	if len(commands) == 3:
		fail("COMMAND_FAILED", "fixture failed movement")
	return b""
run = failing_run
try:
	physical(dict(operation="drag", physical=True,
		options=dict(**{"from": dict(x=1, y=2), "to": dict(x=3, y=4)})))
except BackendError:
	pass
print(json.dumps(commands))
`),
		).toEqual([
			["ydotool", "mousemove", "--absolute", "-x", "1", "-y", "2"],
			["ydotool", "click", "0x40"],
			["ydotool", "mousemove", "--absolute", "-x", "3", "-y", "4"],
			["ydotool", "click", "0x80"],
		]);
	}, 30_000);

	it.each(["x11", "grim", "portal"])(
		"#given %s capture support #when screenshot runs #then captures without raising and reports actual scope",
		async (backend) => {
			const result = await python(String.raw`
backend = ${JSON.stringify(backend)}
if backend == "x11":
	os.environ.pop("WAYLAND_DISPLAY", None)
shutil.which = lambda name: name if backend != "portal" else None
portal_image = lambda: b"portal image"
class Pixels:
	def get_width(self): return 1920
	def get_height(self): return 1080
	def save_to_bufferv(self, format_name, keys, values): return True, b"encoded image"
class Loader:
	def write(self, data): pass
	def close(self): pass
	def get_pixbuf(self): return Pixels()
repository.GdkPixbuf = types.SimpleNamespace(PixbufLoader=types.SimpleNamespace(new=Loader))
image = capture(dict(windowId=99))
print(json.dumps(dict(scope=image["scope"], width=image["width"], height=image["height"],
	data=base64.b64decode(image["data"]).decode(), commands=commands)))
`);
			const commands =
				backend === "x11" ? [["import", "-window", "99", "png:-"]] : backend === "grim" ? [["grim", "-"]] : [];
			expect(result).toEqual({
				scope: backend === "x11" ? "window" : "screen",
				width: 1920,
				height: 1080,
				data: "encoded image",
				commands,
			});
		},
	);

	it("#given Wayland window capture required #when screenshot runs #then explicitly reports FULL_SCREEN_ONLY", async () => {
		expect(
			await python(String.raw`
try:
	capture(dict(windowId=1, requireWindow=True))
	result = "incorrectly captured"
except BackendError as error:
	result = error.code
print(json.dumps(dict(result=result, commands=commands)))
`),
		).toEqual({ result: "FULL_SCREEN_ONLY", commands: [] });
	}, 30_000);

	it("#given a missing Python executable #when spawned #then reports installation guidance through the actual transport", async () => {
		const client = new LinuxHelperClient({
			helperFactory: spawnLinuxHelper("/opencua-nonexistent-python"),
			timeoutMs: 2000,
		});
		try {
			await expect(client.request("listApps")).rejects.toMatchObject({
				code: "MISSING_DEPENDENCY",
				message: expect.stringContaining("sudo apt install"),
			});
		} finally {
			client.close();
		}
	}, 30_000);
});
