// OpenCUA shared surface shell for Windows: a WebView2 window driven by surface-driver.ts, which runs
// the shared CursorMux and writes JSON lines on stdin (same protocol as the Linux GTK shell):
//   {"t":"pointer","kind":"down|drag|up|move","x":..,"y":..}  merged page pointer, window points
//   {"t":"mark","tag":..,"x":..,"y":..,"down":bool}           where an agent's cursor is
// Pointer events go into the page through the DevTools Input.dispatchMouseEvent command: they are
// trusted page input and never move the OS mouse or take focus. Cursor marks and regions are an
// in-page layer with pointer-events: none, so they never take input.
// Usage: OpenCuaSurface <url> <title> <width> <height> [cursor-names.json]
using System.Text.Json;
using Microsoft.Web.WebView2.WinForms;

internal static class Program {
	private const string MarkLayer = """
		(function (marks, names) {
		  let layer = document.getElementById("__opencua_layer");
		  if (!layer) {
		    layer = document.createElement("div");
		    layer.id = "__opencua_layer";
		    layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
		    document.documentElement.appendChild(layer);
		  }
		  layer.replaceChildren();
		  for (const [key, entry] of Object.entries(names || {})) {
		    const r = entry && entry.region;
		    if (!r || !(r.width > 0) || !(r.height > 0)) continue;
		    const box = document.createElement("div");
		    box.style.cssText = `position:fixed;left:${r.x}px;top:${r.y}px;width:${r.width}px;height:${r.height}px;` +
		      `border:1.5px dashed ${entry.color || "#fff"};background:${entry.color || "#fff"}1f;box-sizing:border-box`;
		    layer.appendChild(box);
		  }
		  for (const [key, mark] of Object.entries(marks)) {
		    const entry = (names || {})[key] || {};
		    const label = document.createElement("div");
		    const badge = typeof entry.badge === "string" && entry.badge.length > 0 && entry.badge.length <= 8 ? " " + entry.badge : "";
		    label.textContent = (typeof entry.name === "string" ? entry.name : "cursor " + key) + badge;
		    label.style.cssText = `position:fixed;left:${mark.x}px;top:${mark.y}px;font:bold 9px system-ui;` +
		      `padding:0 3px;border-radius:3px;background:${entry.color || "#fff"};color:#000;` +
		      `transform:translate(10px,13px);outline:${mark.down ? 2 : 1}px solid #000`;
		    layer.appendChild(label);
		  }
		})
		""";

	[STAThread]
	private static int Main(string[] args) {
		if (args.Length < 4) {
			Console.Error.WriteLine("usage: OpenCuaSurface <url> <title> <width> <height> [cursor-names.json]");
			return 2;
		}
		ApplicationConfiguration.Initialize();
		var form = new Form { Text = args[1], Width = int.Parse(args[2]), Height = int.Parse(args[3]), ShowInTaskbar = true };
		var view = new WebView2 { Dock = DockStyle.Fill };
		form.Controls.Add(view);
		var marks = new Dictionary<string, object>();
		var namesPath = args.Length > 4 ? args[4] : null;
		form.Shown += async (_, _) => {
			await view.EnsureCoreWebView2Async();
			view.CoreWebView2.Navigate(args[0]);
			var reader = new Thread(() => {
				string? line;
				while ((line = Console.ReadLine()) != null) {
					var text = line;
					form.BeginInvoke(async () => await Apply(view, marks, namesPath, text));
				}
				form.BeginInvoke(form.Close);
			}) { IsBackground = true };
			reader.Start();
		};
		Application.Run(form);
		return 0;
	}

	private static string Names(string? path) {
		if (path is null) return "{}";
		try {
			using var document = JsonDocument.Parse(File.ReadAllText(path));
			return document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement.GetRawText() : "{}";
		} catch (Exception error) when (error is IOException or JsonException or UnauthorizedAccessException) {
			return "{}";
		}
	}

	private static async Task Apply(WebView2 view, Dictionary<string, object> marks, string? namesPath, string line) {
		JsonElement command;
		try {
			command = JsonDocument.Parse(line).RootElement;
		} catch (JsonException) {
			return;
		}
		if (command.ValueKind == JsonValueKind.Object && command.TryGetProperty("t", out var early)) {
			if (early.GetString() == "init" && command.TryGetProperty("scripts", out var scripts) && scripts.ValueKind == JsonValueKind.Array) {
				foreach (var source in scripts.EnumerateArray()) {
					if (source.ValueKind != JsonValueKind.String) continue;
					await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(source.GetString()!);
					await view.CoreWebView2.ExecuteScriptAsync(source.GetString()!);
				}
				return;
			}
			if (early.GetString() == "speak" && command.TryGetProperty("audio", out var audio) && audio.ValueKind == JsonValueKind.String) {
				await view.CoreWebView2.ExecuteScriptAsync($"window.__opencuaSpeak && window.__opencuaSpeak({JsonSerializer.Serialize(audio.GetString())})");
				return;
			}
		}
		if (command.ValueKind != JsonValueKind.Object ||
			!command.TryGetProperty("x", out var xValue) || !xValue.TryGetDouble(out var x) || !double.IsFinite(x) ||
			!command.TryGetProperty("y", out var yValue) || !yValue.TryGetDouble(out var y) || !double.IsFinite(y) ||
			!command.TryGetProperty("t", out var type)) {
			return;
		}
		// Agents send points relative to the window, frame included; the page wants CSS pixels of the WebView's
		// client area, so the frame offset is removed and the DPI scale undone.
		var form = view.FindForm();
		if (form != null) {
			var origin = view.PointToScreen(System.Drawing.Point.Empty);
			var scale = view.DeviceDpi / 96.0;
			x = (x - (origin.X - form.Bounds.X)) / scale;
			y = (y - (origin.Y - form.Bounds.Y)) / scale;
		}
		if (type.GetString() == "pointer" && command.TryGetProperty("kind", out var kindValue)) {
			var (eventType, buttons) = kindValue.GetString() switch {
				"down" => ("mousePressed", 1),
				"drag" => ("mouseMoved", 1),
				"up" => ("mouseReleased", 0),
				"move" => ("mouseMoved", 0),
				_ => ("", 0),
			};
			if (eventType.Length == 0) return;
			var button = eventType == "mouseMoved" && buttons == 0 ? "none" : "left";
			var parameters = JsonSerializer.Serialize(new {
				type = eventType, x, y, button, buttons, clickCount = eventType == "mouseMoved" ? 0 : 1,
			});
			await view.CoreWebView2.CallDevToolsProtocolMethodAsync("Input.dispatchMouseEvent", parameters);
		} else if (type.GetString() == "mark" && command.TryGetProperty("tag", out var tagValue) && tagValue.TryGetInt64(out var tag)) {
			var down = command.TryGetProperty("down", out var downValue) && downValue.ValueKind == JsonValueKind.True;
			marks[tag.ToString()] = new { x, y, down };
			var script = $"{MarkLayer}({JsonSerializer.Serialize(marks)}, {Names(namesPath)})";
			await view.CoreWebView2.ExecuteScriptAsync(script);
		}
	}
}
