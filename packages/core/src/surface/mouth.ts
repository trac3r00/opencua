/**
 * The agent's "mouth" on an owned surface: a page script that answers audio-only getUserMedia with a
 * stream the agent speaks into, so voice search, dictation and call pages hear the agent instead of a
 * microphone. Audio-and-video requests still get the real devices (none on an owned surface). The
 * agent speaks with `window.__opencuaSpeak(base64)` (any format the page's decodeAudioData reads, e.g.
 * WAV); the promise resolves with the clip's seconds once it has been played into the stream.
 */
export const MOUTH_SCRIPT = String.raw`(() => {
  if (window.__opencuaSpeak) return;
  const AudioContextType = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextType) return;
  if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
  const context = new AudioContextType();
  const destination = context.createMediaStreamDestination();
  const original = navigator.mediaDevices.getUserMedia ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (constraints && constraints.audio && !constraints.video) {
      await context.resume();
      return new MediaStream(destination.stream.getAudioTracks().map((track) => track.clone()));
    }
    if (!original) throw new DOMException("No media devices on this surface", "NotFoundError");
    return original(constraints);
  };
  window.__opencuaSpeak = async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const buffer = await context.decodeAudioData(bytes.buffer);
    await context.resume();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    const ended = new Promise((resolve) => { source.onended = resolve; });
    source.start();
    await ended;
    return buffer.duration;
  };
})();`;

/** 16-bit PCM mono WAV of samples in [-1, 1] at `rate` Hz: the format every engine's decodeAudioData reads. */
export function pcmWav(samples: Float32Array, rate: number): Buffer {
	if (!Number.isSafeInteger(rate) || rate < 3000 || rate > 384000)
		throw new RangeError("rate must be 3000 to 384000 Hz");
	const data = Buffer.alloc(samples.length * 2);
	samples.forEach((sample, index) => {
		const clamped = Math.max(-1, Math.min(1, Number.isFinite(sample) ? sample : 0));
		data.writeInt16LE(Math.round(clamped * 32767), index * 2);
	});
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + data.length, 4);
	header.write("WAVEfmt ", 8, "ascii");
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(data.length, 40);
	return Buffer.concat([header, data]);
}

export function speakScript(audio: Buffer): string {
	return `window.__opencuaSpeak(${JSON.stringify(audio.toString("base64"))})`;
}
