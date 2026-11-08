/**
 * One self-contained HTML file that replays a multi-agent run: every cursor's path and presses, the
 * accessibility changes, audio levels and the agents' decisions on one timeline with play, pause and
 * scrub. No network, no external assets: the file can be attached to an issue or posted as is.
 */
export type ReplayEvent =
	| {
			readonly t: number;
			readonly type: "cursor";
			readonly cursor: string;
			readonly x: number;
			readonly y: number;
			readonly down: boolean;
	  }
	| {
			readonly t: number;
			readonly type: "ax";
			readonly cursor: string;
			readonly added: number;
			readonly removed: number;
			readonly changed: number;
	  }
	| { readonly t: number; readonly type: "audio"; readonly cursor: string; readonly peak: number }
	| { readonly t: number; readonly type: "decision"; readonly cursor: string; readonly text: string };

export interface ReplayMeta {
	readonly title: string;
	readonly width: number;
	readonly height: number;
	readonly colors?: Readonly<Record<string, string>>;
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

function valid(event: ReplayEvent): boolean {
	if (!Number.isFinite(event.t) || event.t < 0 || event.cursor.length === 0 || event.cursor.length > 64) return false;
	switch (event.type) {
		case "cursor":
			return Number.isFinite(event.x) && Number.isFinite(event.y);
		case "ax":
			return [event.added, event.removed, event.changed].every((count) => Number.isSafeInteger(count) && count >= 0);
		case "audio":
			return Number.isFinite(event.peak) && event.peak >= 0 && event.peak <= 1;
		case "decision":
			return event.text.length <= 2000;
	}
}

/** JSON that is safe inside a <script> element: no "</script", "<!--" or line separators can end it early. */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/** Events sorted by time, invalid ones dropped (their count is shown in the file). */
export function exportReplayHtml(events: readonly ReplayEvent[], meta: ReplayMeta): string {
	const kept = events.filter(valid).sort((a, b) => a.t - b.t);
	const colors = Object.fromEntries(Object.entries(meta.colors ?? {}).filter(([, color]) => COLOR.test(color)));
	const data = scriptJson({
		title: meta.title,
		width: meta.width,
		height: meta.height,
		colors,
		dropped: events.length - kept.length,
		events: kept,
	});
	return `<!doctype html><html><head><meta charset="utf-8"><title>OpenCUA replay</title>
<style>body{margin:0;font:13px system-ui;background:#111;color:#eee}#bar{display:flex;gap:8px;align-items:center;padding:8px}
#stage{display:block;background:#fff;margin:0 8px}#lanes{display:block;margin:8px}input[type=range]{flex:1}#log{padding:0 8px;white-space:pre-wrap;color:#ccc}</style></head>
<body><div id="bar"><button id="play">Play</button><input id="scrub" type="range" min="0" max="1000" value="1000"><span id="clock"></span></div>
<canvas id="stage"></canvas><canvas id="lanes" height="90"></canvas><div id="log"></div>
<script>const REPLAY=${data};
(() => {
  const palette = ["#ff5a5f", "#3a86ff", "#2ec4b6", "#ffbe0b", "#8338ec", "#fb5607"];
  const cursors = [...new Set(REPLAY.events.map((e) => e.cursor))];
  const color = (id) => REPLAY.colors[id] || palette[cursors.indexOf(id) % palette.length];
  const end = REPLAY.events.length ? REPLAY.events[REPLAY.events.length - 1].t : 0;
  const stage = document.getElementById("stage"), lanes = document.getElementById("lanes");
  const scale = Math.min(1, 900 / REPLAY.width);
  stage.width = REPLAY.width * scale; stage.height = REPLAY.height * scale; lanes.width = stage.width;
  document.title = "OpenCUA replay: " + REPLAY.title;
  function state(t) {
    const out = {};
    for (const e of REPLAY.events) {
      if (e.t > t) break;
      const s = (out[e.cursor] = out[e.cursor] || { trail: [], down: false, decision: "", peak: 0 });
      if (e.type === "cursor") { s.trail.push([e.x, e.y, e.down]); s.down = e.down; }
      else if (e.type === "decision") s.decision = e.text;
      else if (e.type === "audio") s.peak = e.peak;
    }
    return out;
  }
  function draw(t) {
    const g = stage.getContext("2d"), s = state(t);
    g.clearRect(0, 0, stage.width, stage.height);
    for (const id of Object.keys(s)) {
      const trail = s[id].trail; g.strokeStyle = color(id); g.lineWidth = 2;
      for (let i = 1; i < trail.length; i++) if (trail[i][2] && trail[i - 1][2]) {
        g.beginPath(); g.moveTo(trail[i - 1][0] * scale, trail[i - 1][1] * scale); g.lineTo(trail[i][0] * scale, trail[i][1] * scale); g.stroke();
      }
      const last = trail[trail.length - 1];
      if (last) { g.fillStyle = color(id); g.beginPath(); g.arc(last[0] * scale, last[1] * scale, s[id].down ? 6 : 4, 0, 7); g.fill();
        g.fillText(id + (s[id].decision ? ": " + s[id].decision : ""), last[0] * scale + 8, last[1] * scale - 8); }
    }
    const l = lanes.getContext("2d"); l.clearRect(0, 0, lanes.width, lanes.height); l.fillStyle = "#222"; l.fillRect(0, 0, lanes.width, lanes.height);
    const x = (time) => (end ? time / end : 0) * lanes.width;
    for (const e of REPLAY.events) {
      l.fillStyle = color(e.cursor);
      if (e.type === "ax") l.fillRect(x(e.t), 5, 2, Math.min(25, 3 + e.added + e.removed + e.changed));
      if (e.type === "audio") l.fillRect(x(e.t), 60 - e.peak * 25, 2, e.peak * 25);
      if (e.type === "decision") l.fillRect(x(e.t) - 1, 65, 3, 20);
    }
    l.fillStyle = "#fff"; l.fillRect(x(t), 0, 1, lanes.height);
    document.getElementById("clock").textContent = t.toFixed(2) + " / " + end.toFixed(2) + " s" + (REPLAY.dropped ? "  (" + REPLAY.dropped + " invalid events left out)" : "");
    document.getElementById("log").textContent = Object.entries(s).map(([id, v]) => id + ": " + (v.decision || "-")).join("\\n");
  }
  const scrub = document.getElementById("scrub"); let playing = null;
  const at = () => (scrub.value / 1000) * end;
  scrub.oninput = () => draw(at());
  document.getElementById("play").onclick = () => {
    if (playing) { cancelAnimationFrame(playing); playing = null; return; }
    const start = performance.now() - at() * 1000;
    const frame = (now) => { const t = Math.min(end, (now - start) / 1000); scrub.value = end ? (t / end) * 1000 : 1000; draw(t); playing = t < end ? requestAnimationFrame(frame) : null; };
    playing = requestAnimationFrame(frame);
  };
  window.__replay = { state, draw, end };
  draw(end);
})();</script></body></html>
`;
}
