type AudioStatusCallback = (status: {
  systemAudio: 'connected' | 'disconnected' | 'error' | 'unavailable';
  microphone: 'connected' | 'disconnected' | 'error' | 'denied';
}) => void;

type AudioDataCallback = (source: 'system' | 'microphone', data: ArrayBuffer) => void;

let systemStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let systemProcessor: ScriptProcessorNode | null = null;
let micProcessor: ScriptProcessorNode | null = null;
let systemContext: AudioContext | null = null;
let micContext: AudioContext | null = null;

export async function startSystemAudioCapture(
  onData: AudioDataCallback,
  onStatus: AudioStatusCallback
): Promise<boolean> {
  try {
    systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    });

    const audioTracks = systemStream.getAudioTracks();
    if (audioTracks.length === 0) {
      onStatus({ systemAudio: 'unavailable', microphone: 'disconnected' });
      systemStream.getTracks().forEach(t => t.stop());
      systemStream = null;
      return false;
    }

    const videoTracks = systemStream.getVideoTracks();
    videoTracks.forEach(t => t.stop());

    systemContext = new AudioContext({ sampleRate: 16000 });
    const source = systemContext.createMediaStreamSource(
      new MediaStream(audioTracks)
    );
    systemProcessor = systemContext.createScriptProcessor(4096, 1, 1);

    systemProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const pcm16 = float32ToInt16(inputData);
      onData('system', pcm16.buffer);
    };

    source.connect(systemProcessor);
    systemProcessor.connect(systemContext.destination);

    audioTracks[0].addEventListener('ended', () => {
      stopSystemAudioCapture();
      onStatus({ systemAudio: 'disconnected', microphone: micStream ? 'connected' : 'disconnected' });
    });

    onStatus({ systemAudio: 'connected', microphone: micStream ? 'connected' : 'disconnected' });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audio] System audio capture failed:', msg);
    onStatus({ systemAudio: 'error', microphone: micStream ? 'connected' : 'disconnected' });
    return false;
  }
}

export async function startMicrophoneCapture(
  onData: AudioDataCallback,
  onStatus: AudioStatusCallback
): Promise<boolean> {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: 16000,
      },
    });

    micContext = new AudioContext({ sampleRate: 16000 });
    const source = micContext.createMediaStreamSource(micStream);
    micProcessor = micContext.createScriptProcessor(4096, 1, 1);

    micProcessor.onaudioprocess = (event) => {
      const inputData = event.inputBuffer.getChannelData(0);
      const pcm16 = float32ToInt16(inputData);
      onData('microphone', pcm16.buffer);
    };

    source.connect(micProcessor);
    micProcessor.connect(micContext.destination);

    onStatus({
      systemAudio: systemStream ? 'connected' : 'disconnected',
      microphone: 'connected',
    });
    return true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[audio] Microphone capture failed:', msg);
    const micStatus = msg.includes('denied') || msg.includes('NotAllowedError') ? 'denied' as const : 'error' as const;
    onStatus({
      systemAudio: systemStream ? 'connected' : 'disconnected',
      microphone: micStatus,
    });
    return false;
  }
}

export function stopSystemAudioCapture(): void {
  systemProcessor?.disconnect();
  systemProcessor = null;
  systemContext?.close().catch(() => {});
  systemContext = null;
  systemStream?.getTracks().forEach(t => t.stop());
  systemStream = null;
}

export function stopMicrophoneCapture(): void {
  micProcessor?.disconnect();
  micProcessor = null;
  micContext?.close().catch(() => {});
  micContext = null;
  micStream?.getTracks().forEach(t => t.stop());
  micStream = null;
}

export function stopAllCapture(): void {
  stopSystemAudioCapture();
  stopMicrophoneCapture();
}

export function isSystemAudioActive(): boolean {
  return systemStream !== null && systemStream.getAudioTracks().some(t => t.readyState === 'live');
}

export function isMicrophoneActive(): boolean {
  return micStream !== null && micStream.getAudioTracks().some(t => t.readyState === 'live');
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}
