// Captures this participant's OWN microphone for server-side transcription.
// The server labels the speaker from the authenticated connection, so no
// speaker field is sent.
//
// 'segments' mode (Whisper): an energy-based voice-activity detector cuts
// speech into segments: 800 ms of silence ends a segment, 15 s max per chunk.
// 'stream' mode (Deepgram): raw 16 kHz PCM is streamed continuously.

const SAMPLE_RATE = 16000;
const FRAME = 2048; // 128 ms per audio callback at 16 kHz
const FRAME_MS = (FRAME / SAMPLE_RATE) * 1000;
const END_SILENCE_MS = 800;
const MAX_SEGMENT_MS = 15_000;
const MIN_SPEECH_MS = 300;
const PREROLL_FRAMES = 3; // keep ~400 ms before speech starts

function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function toPcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

export function createTranscriber({ sendWS, getMicTrack }) {
  let mode = 'unavailable';
  let active = false;
  let ctx = null;
  let node = null; // { track, src, proc }
  let syncTimer = null;

  // VAD state
  let speaking = false;
  let frames = [];
  let preroll = [];
  let speechMs = 0;
  let silentMs = 0;
  let noise = 0.004; // running estimate of the background level

  function resetVad() {
    speaking = false;
    frames = [];
    preroll = [];
    speechMs = 0;
    silentMs = 0;
  }

  function flush() {
    if (speechMs >= MIN_SPEECH_MS && frames.length) {
      const total = frames.reduce((n, f) => n + f.length, 0);
      const pcm = new Int16Array(total);
      let offset = 0;
      for (const f of frames) { pcm.set(f, offset); offset += f.length; }
      sendWS({ type: 'audio_segment', data: toBase64(pcm) });
    }
    frames = [];
    speechMs = 0;
    silentMs = 0;
  }

  function onFrame(float32) {
    const pcm = toPcm16(float32);
    if (mode === 'stream') {
      sendWS({ type: 'room_audio', data: toBase64(pcm) });
      return;
    }
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    const rms = Math.sqrt(sum / float32.length);
    const isSpeech = rms > Math.max(0.012, noise * 3);

    if (!speaking) {
      preroll.push(pcm);
      if (preroll.length > PREROLL_FRAMES) preroll.shift();
      if (isSpeech) {
        speaking = true;
        frames = [...preroll];
        preroll = [];
        speechMs = FRAME_MS;
        silentMs = 0;
        sendWS({ type: 'speech_activity', speaking: true });
      } else {
        noise = noise * 0.95 + rms * 0.05;
      }
      return;
    }

    frames.push(pcm);
    if (isSpeech) { speechMs += FRAME_MS; silentMs = 0; } else { silentMs += FRAME_MS; }
    const durationMs = frames.length * FRAME_MS;
    if (silentMs >= END_SILENCE_MS) {
      flush();
      speaking = false;
      sendWS({ type: 'speech_activity', speaking: false });
    } else if (durationMs >= MAX_SEGMENT_MS) {
      flush(); // long answer: cut and keep listening
    }
  }

  function stopCapture() {
    if (node) { node.proc.disconnect(); node.src.disconnect(); node = null; }
    if (speaking) sendWS({ type: 'speech_activity', speaking: false });
    resetVad();
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
  }

  function sync() {
    const track = active && mode !== 'unavailable' ? getMicTrack() : null;
    if (!track) {
      stopCapture();
      return;
    }
    if (node?.track === track) return;
    if (node) { node.proc.disconnect(); node.src.disconnect(); node = null; }
    resetVad();
    ctx ??= new AudioContext({ sampleRate: SAMPLE_RATE });
    ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = (ev) => onFrame(ev.inputBuffer.getChannelData(0));
    src.connect(proc);
    proc.connect(ctx.destination); // output is silent; needed for processing to run
    node = { track, src, proc };
  }

  const syncLater = () => { clearTimeout(syncTimer); syncTimer = setTimeout(sync, 50); };

  return {
    setMode(m) { mode = m || 'unavailable'; syncLater(); },
    /** Capture only while the interview is LIVE and the WebSocket is open. */
    setActive(a) { active = a; syncLater(); },
    /** Call when local tracks change (mute/unmute, device switch). */
    sync: syncLater,
    stop: stopCapture,
  };
}
