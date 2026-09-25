import {
  Room,
  RoomEvent,
  Track,
  RemoteTrack,
  RemoteTrackPublication,
  RemoteParticipant,
  LocalParticipant,
  ConnectionState,
} from 'livekit-client';

type AudioDataCallback = (source: 'system' | 'microphone', data: ArrayBuffer) => void;

type LiveKitStatus = {
  room: 'connected' | 'connecting' | 'disconnected' | 'error';
  interviewerAudio: 'receiving' | 'waiting' | 'disconnected';
  candidateAudio: 'receiving' | 'disconnected';
  interviewerIdentity: string | null;
  lastInterviewerTranscript: string;
};

type StatusCallback = (status: Partial<LiveKitStatus>) => void;

export type VideoTracks = {
  remoteCamera: MediaStreamTrack | null;
  localCamera: MediaStreamTrack | null;
  cameraEnabled: boolean;
  screenSharing: boolean;
};

type VideoCallback = (tracks: VideoTracks) => void;

let room: Room | null = null;
let interviewerProcessor: { context: AudioContext; processor: ScriptProcessorNode } | null = null;
// Plays the interviewer's audio. Chrome also needs remote WebRTC audio attached to a media
// element before Web Audio receives real samples (otherwise the capture pipeline gets silence).
let interviewerAudioEl: { track: RemoteTrack; el: HTMLMediaElement } | null = null;
let candidateProcessor: { context: AudioContext; processor: ScriptProcessorNode } | null = null;
let onAudioData: AudioDataCallback | null = null;
let onStatusChange: StatusCallback | null = null;
let onVideoChange: VideoCallback | null = null;

let interviewerPacketCount = 0;
let candidatePacketCount = 0;

export function getAudioPacketCounts(): { interviewer: number; candidate: number } {
  return { interviewer: interviewerPacketCount, candidate: candidatePacketCount };
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function createAudioPipeline(
  track: MediaStreamTrack,
  source: 'system' | 'microphone'
): { context: AudioContext; processor: ScriptProcessorNode } {
  const context = new AudioContext({ sampleRate: 16000 });

  context.resume().then(() => {
    console.log(`[audio] ${source} AudioContext resumed (state=${context.state}, sampleRate=${context.sampleRate})`);
  }).catch((err) => {
    console.error(`[audio] ${source} AudioContext resume failed:`, err);
  });

  const mediaStream = new MediaStream([track]);
  const audioSource = context.createMediaStreamSource(mediaStream);
  const processor = context.createScriptProcessor(4096, 1, 1);

  let frameCount = 0;

  processor.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);

    let hasSignal = false;
    for (let i = 0; i < inputData.length; i += 64) {
      if (Math.abs(inputData[i]) > 0.001) {
        hasSignal = true;
        break;
      }
    }

    const pcm16 = float32ToInt16(inputData);

    if (source === 'system') {
      interviewerPacketCount++;
      if (interviewerPacketCount === 1 || interviewerPacketCount % 100 === 0) {
        console.log(`[audio] Interviewer PCM packets: ${interviewerPacketCount}, hasSignal=${hasSignal}, contextState=${context.state}`);
      }
    } else {
      candidatePacketCount++;
      if (candidatePacketCount === 1 || candidatePacketCount % 200 === 0) {
        console.log(`[audio] Candidate PCM packets: ${candidatePacketCount}`);
      }
    }

    onAudioData?.(source, pcm16.buffer as ArrayBuffer);
  };

  audioSource.connect(processor);
  processor.connect(context.destination);

  if (context.state === 'suspended') {
    console.warn(`[audio] ${source} AudioContext is SUSPENDED — calling resume()`);
    context.resume();
  }

  console.log(`[audio] ${source} pipeline created (contextState=${context.state}, sampleRate=${context.sampleRate}, trackEnabled=${track.enabled}, trackReadyState=${track.readyState})`);
  return { context, processor };
}

function liveTrack(pub: { track?: { mediaStreamTrack: MediaStreamTrack } | undefined; isMuted: boolean } | undefined) {
  return pub && !pub.isMuted ? pub.track?.mediaStreamTrack ?? null : null;
}

function emitVideo(): void {
  if (!room || !onVideoChange) return;
  const remote = Array.from(room.remoteParticipants.values())[0];
  const local = room.localParticipant;
  onVideoChange({
    remoteCamera: liveTrack(remote?.getTrackPublication(Track.Source.Camera)),
    localCamera: liveTrack(local.getTrackPublication(Track.Source.Camera)),
    cameraEnabled: local.isCameraEnabled,
    screenSharing: local.isScreenShareEnabled,
  });
}

function handleRemoteTrackSubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant
): void {
  if (track.kind !== Track.Kind.Audio) return;

  console.log(`[livekit] Interviewer audio track subscribed from: ${participant.identity}`);

  const mediaTrack = track.mediaStreamTrack;
  if (!mediaTrack) {
    console.error('[livekit] No MediaStreamTrack on remote audio track');
    return;
  }

  if (interviewerProcessor) {
    interviewerProcessor.processor.disconnect();
    interviewerProcessor.context.close().catch(() => {});
  }
  detachInterviewerAudio();

  const el = track.attach();
  el.style.display = 'none';
  document.body.appendChild(el);
  interviewerAudioEl = { track, el };

  interviewerProcessor = createAudioPipeline(mediaTrack, 'system');

  onStatusChange?.({
    interviewerAudio: 'receiving',
    interviewerIdentity: participant.identity,
  });
}

function handleRemoteTrackUnsubscribed(
  track: RemoteTrack,
  publication: RemoteTrackPublication,
  participant: RemoteParticipant
): void {
  if (track.kind !== Track.Kind.Audio) return;

  console.log(`[livekit] Interviewer audio track unsubscribed: ${participant.identity}`);

  if (interviewerProcessor) {
    interviewerProcessor.processor.disconnect();
    interviewerProcessor.context.close().catch(() => {});
    interviewerProcessor = null;
  }
  detachInterviewerAudio();

  onStatusChange?.({
    interviewerAudio: 'disconnected',
    interviewerIdentity: null,
  });
}

function setupCandidateMicPipeline(localParticipant: LocalParticipant): void {
  const micPub = localParticipant.getTrackPublication(Track.Source.Microphone);
  if (!micPub?.track?.mediaStreamTrack) {
    console.log('[audio] Candidate mic track not yet available');
    return;
  }

  if (candidateProcessor) {
    candidateProcessor.processor.disconnect();
    candidateProcessor.context.close().catch(() => {});
  }

  candidateProcessor = createAudioPipeline(micPub.track.mediaStreamTrack, 'microphone');
  onStatusChange?.({ candidateAudio: 'receiving' });
}

export async function connectToRoom(
  url: string,
  token: string,
  audioDataCb: AudioDataCallback,
  statusCb: StatusCallback,
  videoCb?: VideoCallback
): Promise<void> {
  onAudioData = audioDataCb;
  onStatusChange = statusCb;
  onVideoChange = videoCb ?? null;

  if (room) {
    await disconnectFromRoom();
  }

  room = new Room({
    adaptiveStream: true,
    dynacast: true,
  });

  room.on(RoomEvent.ConnectionStateChanged, (state: ConnectionState) => {
    console.log(`[livekit] Connection state: ${state}`);
    statusCb({
      room: state === ConnectionState.Connected ? 'connected'
        : state === ConnectionState.Connecting ? 'connecting'
        : state === ConnectionState.Reconnecting ? 'connecting'
        : 'disconnected',
    });
  });

  room.on(RoomEvent.TrackSubscribed, handleRemoteTrackSubscribed);
  room.on(RoomEvent.TrackUnsubscribed, handleRemoteTrackUnsubscribed);

  for (const event of [
    RoomEvent.TrackSubscribed,
    RoomEvent.TrackUnsubscribed,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ParticipantDisconnected,
  ]) {
    room.on(event, emitVideo);
  }

  room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
    console.log(`[livekit] Participant connected: ${participant.identity}`);
  });

  room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
    console.log(`[livekit] Participant disconnected: ${participant.identity}`);
  });

  room.on(RoomEvent.LocalTrackPublished, (pub) => {
    if (pub.source === Track.Source.Microphone && room?.localParticipant) {
      setupCandidateMicPipeline(room.localParticipant);
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log('[livekit] Disconnected from room');
    statusCb({ room: 'disconnected', interviewerAudio: 'disconnected', candidateAudio: 'disconnected' });
  });

  try {
    statusCb({ room: 'connecting' });
    await room.connect(url, token);
    console.log(`[livekit] Connected to room: ${room.name}`);
    statusCb({ room: 'connected' });

    await room.localParticipant.setMicrophoneEnabled(true);
    console.log('[livekit] Microphone enabled');

    // Camera is optional: a missing or blocked webcam must not fail the session.
    try {
      await room.localParticipant.setCameraEnabled(true);
      console.log('[livekit] Camera enabled');
    } catch (err) {
      console.warn('[livekit] Camera unavailable:', err);
    }
    emitVideo();

    setTimeout(() => {
      if (room?.localParticipant) {
        setupCandidateMicPipeline(room.localParticipant);
      }
    }, 1000);

    room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((pub) => {
        if (pub.track && pub.track.kind === Track.Kind.Audio) {
          handleRemoteTrackSubscribed(
            pub.track as RemoteTrack,
            pub as RemoteTrackPublication,
            participant
          );
        }
      });
    });

    if (room.remoteParticipants.size === 0) {
      statusCb({ interviewerAudio: 'waiting' });
    }
  } catch (err) {
    console.error('[livekit] Connection failed:', err);
    statusCb({ room: 'error' });
    throw err;
  }
}

function detachInterviewerAudio(): void {
  if (!interviewerAudioEl) return;
  interviewerAudioEl.track.detach(interviewerAudioEl.el);
  interviewerAudioEl.el.remove();
  interviewerAudioEl = null;
}

export async function disconnectFromRoom(): Promise<void> {
  detachInterviewerAudio();

  if (interviewerProcessor) {
    interviewerProcessor.processor.disconnect();
    interviewerProcessor.context.close().catch(() => {});
    interviewerProcessor = null;
  }

  if (candidateProcessor) {
    candidateProcessor.processor.disconnect();
    candidateProcessor.context.close().catch(() => {});
    candidateProcessor = null;
  }

  if (room) {
    await room.disconnect();
    room = null;
  }

  onAudioData = null;
  onStatusChange = null;
  onVideoChange = null;
  interviewerPacketCount = 0;
  candidatePacketCount = 0;
}

export function isConnected(): boolean {
  return room?.state === ConnectionState.Connected;
}

export function getRoom(): Room | null {
  return room;
}

export async function toggleCandidateMic(enabled: boolean): Promise<boolean> {
  if (!room || room.state !== ConnectionState.Connected) {
    console.warn('[livekit] Cannot toggle mic — not connected');
    return !enabled;
  }
  try {
    await room.localParticipant.setMicrophoneEnabled(enabled);
    console.log(`[livekit] Candidate mic ${enabled ? 'enabled' : 'disabled'}`);
    onStatusChange?.({ candidateAudio: enabled ? 'receiving' : 'disconnected' });
    return enabled;
  } catch (err) {
    console.error('[livekit] Failed to toggle mic:', err);
    const actual = room.localParticipant.isMicrophoneEnabled;
    onStatusChange?.({ candidateAudio: actual ? 'receiving' : 'disconnected' });
    return actual;
  }
}

export async function toggleCamera(enabled: boolean): Promise<boolean> {
  if (!room || room.state !== ConnectionState.Connected) return false;
  try {
    await room.localParticipant.setCameraEnabled(enabled);
  } catch (err) {
    console.error('[livekit] Failed to toggle camera:', err);
  }
  emitVideo();
  return room.localParticipant.isCameraEnabled;
}

// The main process restricts capture to the workspace window (see windows.ts).
export async function toggleScreenShare(enabled: boolean): Promise<boolean> {
  if (!room || room.state !== ConnectionState.Connected) return false;
  try {
    await room.localParticipant.setScreenShareEnabled(enabled, { audio: false });
  } catch (err) {
    console.error('[livekit] Failed to toggle screen share:', err);
  }
  emitVideo();
  return room.localParticipant.isScreenShareEnabled;
}

export function isMicEnabled(): boolean {
  return room?.localParticipant?.isMicrophoneEnabled ?? false;
}
