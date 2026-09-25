// Streams THIS participant's own microphone to the server for speech-to-text.
//
//   LiveKit mic track ──▶ AudioWorklet (16 kHz PCM16, 100 ms) ──▶ binary WebSocket frames
//
// LiveKit keeps delivering the same microphone to the other participant; this
// is a second, independent consumer of the track. The server identifies the
// speaker from the authenticated socket, so no speaker/role is sent.
//
// Protocol: {type:'audio_start', format:'pcm16', sampleRate:16000, channels:1},
// then binary PCM frames, then {type:'audio_stop'}. The server replies with
// {type:'transcription_state', state} for this participant's stream.

const WORKLET_URL = '/room-assets/pcm-worklet.js';
const MAX_BUFFERED = 512 * 1024; // drop audio rather than queue it behind a congested socket

export function createTranscriber({ sendJSON, sendBinary, getMicTrack, onState }) {
  let mode = 'unavailable'; // 'stream' | 'unavailable' (from the server)
  let active = false; // interview LIVE and WebSocket open
  let ctx = null;
  let workletLoaded = false;
  let node = null; // { track, src, worklet, sink }
  let streaming = false; // audio_start sent and frames flowing
  let state = 'idle';
  let serverState = null;
  let syncTimer = null;
  let restartAt = 0;

  // Local capture state + server stream state → one user-facing state.
  function emit() {
    let next;
    if (!active || mode === 'unavailable') next = mode === 'unavailable' && active ? 'unavailable' : 'idle';
    else if (state === 'mic_off' || state === 'initializing' || state === 'blocked' || state === 'error') next = state;
    else if (!streaming) next = 'initializing';
    else next = serverState || 'connecting';
    onState(next);
  }

  function setLocal(s) {
    state = s;
    emit();
  }

  async function ensureContext() {
    ctx ??= new AudioContext();
    if (!workletLoaded) {
      await ctx.audioWorklet.addModule(WORKLET_URL);
      workletLoaded = true;
    }
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    return ctx.state === 'running';
  }

  // Browsers may block audio until the user interacts with the page.
  function resumeOnGesture() {
    const handler = () => {
      document.removeEventListener('pointerdown', handler, true);
      document.removeEventListener('keydown', handler, true);
      syncLater();
    };
    document.addEventListener('pointerdown', handler, true);
    document.addEventListener('keydown', handler, true);
  }

  function detach() {
    if (!node) return;
    node.worklet.port.onmessage = null;
    try { node.src.disconnect(); node.worklet.disconnect(); node.sink.disconnect(); } catch { /* already gone */ }
    node = null;
  }

  function stopStreaming() {
    detach();
    if (streaming) {
      sendJSON({ type: 'audio_stop' });
      streaming = false;
    }
    serverState = null;
  }

  async function sync() {
    if (!active || mode !== 'stream') {
      stopStreaming();
      setLocal('idle');
      return;
    }
    const track = getMicTrack();
    if (!track) {
      stopStreaming();
      setLocal('mic_off');
      return;
    }
    if (node?.track === track && streaming) return;

    setLocal('initializing');
    try {
      if (!(await ensureContext())) {
        setLocal('blocked');
        resumeOnGesture();
        return;
      }
    } catch (err) {
      console.error('[stt] audio capture unavailable:', err);
      setLocal('error');
      return;
    }
    if (!active || getMicTrack() !== track) return; // changed while awaiting

    detach();
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const worklet = new AudioWorkletNode(ctx, 'pcm16-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const sink = ctx.createGain();
    sink.gain.value = 0; // keep the graph pulled without making any sound
    src.connect(worklet);
    worklet.connect(sink);
    sink.connect(ctx.destination);
    node = { track, src, worklet, sink };

    if (!streaming) {
      sendJSON({ type: 'audio_start', format: 'pcm16', sampleRate: 16000, channels: 1 });
      streaming = true;
      serverState = 'connecting';
    }
    worklet.port.onmessage = (ev) => {
      if (!streaming) return;
      sendBinary(ev.data.buffer, MAX_BUFFERED);
    };
    setLocal('capturing');
  }

  function syncLater() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { sync(); }, 50);
  }

  return {
    setMode(m) { mode = m === 'stream' ? 'stream' : 'unavailable'; syncLater(); },
    /** Capture only while the interview is LIVE and the WebSocket is open. */
    setActive(a) {
      if (active && !a) stopStreaming();
      active = a;
      syncLater();
    },
    /** Call when local tracks may have changed (mute/unmute, device switch). */
    sync: syncLater,
    /** transcription_state for this participant's own stream. */
    onServerState(s) {
      if (s === 'stopped' && active && streaming) {
        // The server has no stream for us (e.g. it restarted): start a new one, at most every 3s.
        streaming = false;
        detach();
        if (Date.now() - restartAt > 3000) {
          restartAt = Date.now();
          syncLater();
        }
        return;
      }
      serverState = s;
      emit();
    },
    retry() {
      if (streaming) sendJSON({ type: 'transcription_retry' });
      else syncLater();
    },
    stop() {
      active = false;
      stopStreaming();
      setLocal('idle');
    },
  };
}
