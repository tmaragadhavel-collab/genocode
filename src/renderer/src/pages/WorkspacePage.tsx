import { useEffect, useRef, useCallback, useState } from 'react';
import { useInterviewStore, type ChatItem } from '../stores/interviewStore';
import {
  connectWS, disconnectWS, onWSMessage, sendWSMessage, sendAudioData, joinSession, leaveSession,
} from '../services/wsClient';
import { InterviewChat } from '../components/InterviewChat';
import {
  connectToRoom,
  disconnectFromRoom,
  toggleCandidateMic,
  toggleCamera,
  toggleScreenShare,
  getAudioPacketCounts,
} from '../services/livekitService';
import {
  Mic, MicOff, Monitor, MonitorUp, MonitorX, Radio, Play, Square, Shield,
  ChevronDown, ChevronUp, Wifi, Video, VideoOff, Eye, UserRound, MessageSquare,
} from 'lucide-react';

function StatusDot({ status }: { status: string }) {
  const color: Record<string, string> = {
    connected: 'var(--success)',
    receiving: 'var(--success)',
    disconnected: 'var(--muted)',
    error: 'var(--error)',
    unavailable: 'var(--error)',
    denied: 'var(--error)',
    demo: 'var(--warning)',
    connecting: 'var(--warning)',
    waiting: 'var(--warning)',
  };
  const c = color[status] || 'var(--muted)';
  return (
    <span
      className="inline-block h-2 w-2 rounded-full"
      style={{ background: c, boxShadow: status === 'connected' || status === 'receiving' ? `0 0 6px ${c}` : 'none' }}
    />
  );
}

function AudioStatusPanel() {
  const audioStatus = useInterviewStore((s) => s.audioStatus);
  const livekitStatus = useInterviewStore((s) => s.livekitStatus);

  const items = [
    { label: 'LiveKit Room', icon: Wifi, status: livekitStatus.room },
    { label: 'Interviewer Audio', icon: Monitor, status: livekitStatus.interviewerAudio },
    { label: 'Candidate Mic', icon: Mic, status: livekitStatus.candidateAudio },
    { label: 'Speech Recognition', icon: Radio, status: audioStatus.stt },
  ];

  return (
    <div className="space-y-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--muted)' }}>
        Connection Status
      </div>
      {items.map(({ label, icon: Icon, status }) => (
        <div key={label} className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
          <Icon className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
          <span>{label}</span>
          <span className="ml-auto flex items-center gap-1.5">
            <StatusDot status={status} />
            <span className="text-xs capitalize" style={{ color: 'var(--muted)' }}>{status}</span>
          </span>
        </div>
      ))}
      {livekitStatus.interviewerIdentity && (
        <div className="text-[10px] pl-6" style={{ color: 'var(--muted)' }}>
          Interviewer: {livekitStatus.interviewerIdentity}
        </div>
      )}
    </div>
  );
}

function DebugPanel() {
  const [open, setOpen] = useState(false);
  const transcript = useInterviewStore((s) => s.transcript);
  const livekitStatus = useInterviewStore((s) => s.livekitStatus);
  const audioStatus = useInterviewStore((s) => s.audioStatus);
  const sessionState = useInterviewStore((s) => s.sessionState);
  const [packetCounts, setPacketCounts] = useState({ interviewer: 0, candidate: 0 });

  useEffect(() => {
    if (sessionState === 'idle') return;
    const interval = setInterval(() => {
      setPacketCounts(getAudioPacketCounts());
    }, 1000);
    return () => clearInterval(interval);
  }, [sessionState]);

  const lastInterviewer = [...transcript].reverse().find(t => t.speaker === 'interviewer' && t.isFinal);
  const lastCandidate = [...transcript].reverse().find(t => t.speaker === 'candidate' && t.isFinal);

  return (
    <div className="rounded-lg" style={{ background: 'var(--surface-soft)', border: '1px solid var(--border)' }}>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between px-3 py-2 text-[10px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--muted)' }}
      >
        Audio Diagnostics
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2 text-[11px]" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="pt-2">
            <span style={{ color: 'var(--muted)' }}>Interviewer Audio: </span>
            <StatusDot status={livekitStatus.interviewerAudio} />
            <span className="ml-1 uppercase text-[9px]" style={{ color: 'var(--text)' }}>{livekitStatus.interviewerAudio}</span>
          </div>
          <div>
            <span style={{ color: 'var(--muted)' }}>Interviewer Packets: </span>
            <span className="font-mono text-[9px]" style={{ color: packetCounts.interviewer > 0 ? '#22c55e' : 'var(--muted)' }}>
              {packetCounts.interviewer}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--muted)' }}>STT: </span>
            <StatusDot status={audioStatus.stt} />
            <span className="ml-1 uppercase text-[9px]" style={{ color: 'var(--text)' }}>{audioStatus.stt}</span>
          </div>
          <div>
            <span style={{ color: 'var(--muted)' }}>Deepgram: </span>
            <StatusDot status={audioStatus.stt === 'connected' ? 'connected' : 'disconnected'} />
            <span className="ml-1 uppercase text-[9px]" style={{ color: 'var(--text)' }}>
              {audioStatus.stt === 'connected' ? 'STREAMING' : 'IDLE'}
            </span>
          </div>
          {lastInterviewer && (
            <div>
              <span style={{ color: 'var(--muted)' }}>Last interviewer: </span>
              <span style={{ color: '#60a5fa' }}>"{lastInterviewer.text}"</span>
            </div>
          )}
          <div>
            <span style={{ color: 'var(--muted)' }}>Candidate Audio: </span>
            <StatusDot status={livekitStatus.candidateAudio} />
            <span className="ml-1 uppercase text-[9px]" style={{ color: 'var(--text)' }}>{livekitStatus.candidateAudio}</span>
          </div>
          <div>
            <span style={{ color: 'var(--muted)' }}>Candidate Packets: </span>
            <span className="font-mono text-[9px]" style={{ color: packetCounts.candidate > 0 ? '#22c55e' : 'var(--muted)' }}>
              {packetCounts.candidate}
            </span>
          </div>
          {lastCandidate && (
            <div>
              <span style={{ color: 'var(--muted)' }}>Last candidate: </span>
              <span style={{ color: 'var(--accent)' }}>"{lastCandidate.text}"</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TranscriptView() {
  const transcript = useInterviewStore((s) => s.transcript);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const entries = transcript.filter(t => t.text.trim());

  return (
    <div className="flex-1 overflow-y-auto space-y-3 pr-1" style={{ scrollbarGutter: 'stable' }}>
      {entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Radio className="h-8 w-8 mb-3" style={{ color: 'var(--muted)' }} />
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Waiting for audio... Start the session and have the interviewer speak.
          </p>
        </div>
      ) : (
        entries.map((entry, i) => (
          <div
            key={entry.id ?? i}
            className="rounded-lg px-3 py-2"
            style={{
              background: entry.isFinal ? 'var(--surface-soft)' : 'transparent',
              opacity: entry.isFinal ? 1 : 0.6,
              borderLeft: `3px solid ${entry.speaker === 'interviewer' ? '#60a5fa' : 'var(--accent)'}`,
            }}
          >
            <div className="flex items-center gap-2 mb-1">
              <span
                className="text-[10px] font-bold uppercase tracking-wider"
                style={{ color: entry.speaker === 'interviewer' ? '#60a5fa' : 'var(--accent)' }}
              >
                {entry.speaker === 'interviewer' ? 'Interviewer' : 'Candidate'}
              </span>
              {!entry.isFinal && (
                <span className="text-[8px] px-1.5 py-0.5 rounded-full" style={{ background: 'var(--warning)', color: '#000' }}>
                  PARTIAL
                </span>
              )}
              <span className="text-[9px]" style={{ color: 'var(--muted)' }}>
                {new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false })}
              </span>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
              {entry.text}
            </p>
          </div>
        ))
      )}
      <div ref={bottomRef} />
    </div>
  );
}

function VideoTile({
  track,
  label,
  mirrored,
  emptyText,
  className = '',
}: {
  track: MediaStreamTrack | null;
  label: string;
  mirrored?: boolean;
  emptyText: string;
  className?: string;
}) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.srcObject = track ? new MediaStream([track]) : null;
  }, [track]);

  return (
    <div
      className={`relative overflow-hidden rounded-xl ${className}`}
      style={{ background: 'var(--surface-alt)', border: '1px solid var(--border)' }}
    >
      {track ? (
        <video
          ref={ref}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
          style={mirrored ? { transform: 'scaleX(-1)' } : undefined}
        />
      ) : (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-3 text-center">
          <UserRound className="h-8 w-8" style={{ color: 'var(--muted)' }} />
          <span className="text-xs" style={{ color: 'var(--muted)' }}>{emptyText}</span>
        </div>
      )}
      <span
        className="absolute bottom-2 left-2 rounded-md px-2 py-0.5 text-[11px] font-semibold"
        style={{ background: 'rgba(15,23,42,0.75)', color: '#fff' }}
      >
        {label}
      </span>
    </div>
  );
}

// What the candidate sees: the interviewer large, themselves picture-in-picture.
function VideoStage() {
  const video = useInterviewStore((s) => s.video);
  const livekitStatus = useInterviewStore((s) => s.livekitStatus);
  const interviewerPresent = livekitStatus.interviewerAudio === 'receiving' || !!video.remoteCamera;

  return (
    <div className="mb-4 overflow-hidden rounded-2xl" style={{ border: '1px solid var(--border)' }}>
      {video.screenSharing && (
        <div
          className="flex items-center gap-2 px-4 py-1.5 text-[11px] font-semibold"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          <Eye className="h-3.5 w-3.5" />
          This window is shared — visible to the interviewer
        </div>
      )}
      <div className="relative" style={{ height: 'min(42vh, 420px)', background: 'var(--surface-alt)' }}>
        <VideoTile
          track={video.remoteCamera}
          label="Interviewer"
          emptyText={interviewerPresent ? 'Interviewer camera is off' : 'Waiting for the interviewer to join…'}
          className="h-full w-full rounded-none border-0"
        />
        <VideoTile
          track={video.localCamera}
          label="You"
          mirrored
          emptyText="Camera off"
          className="absolute bottom-3 right-3 aspect-video w-48 shadow-lg"
        />
      </div>
    </div>
  );
}

function CallControls() {
  const video = useInterviewStore((s) => s.video);
  const [busy, setBusy] = useState<'camera' | 'share' | null>(null);

  const run = async (kind: 'camera' | 'share') => {
    setBusy(kind);
    try {
      if (kind === 'camera') await toggleCamera(!video.cameraEnabled);
      else await toggleScreenShare(!video.screenSharing);
    } finally {
      setBusy(null);
    }
  };

  const base = 'flex flex-1 items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition hover:opacity-90 disabled:opacity-50';
  const on = { background: 'rgba(34,197,94,0.15)', color: 'var(--success)', border: '1px solid rgba(34,197,94,0.3)' };
  const off = { background: 'rgba(148,163,184,0.15)', color: 'var(--muted)', border: '1px solid rgba(148,163,184,0.2)' };

  return (
    <div className="space-y-2">
      <button
        onClick={() => run('camera')}
        disabled={busy !== null}
        aria-label={video.cameraEnabled ? 'Camera on — click to turn off' : 'Camera off — click to turn on'}
        className={`${base} w-full`}
        style={video.cameraEnabled ? on : off}
      >
        {video.cameraEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
        {video.cameraEnabled ? 'Camera On' : 'Camera Off'}
      </button>
      <button
        onClick={() => run('share')}
        disabled={busy !== null}
        title="Shares only this workspace window with the interviewer"
        className={`${base} w-full`}
        style={video.screenSharing
          ? { background: 'var(--accent-soft)', color: 'var(--accent)', border: '1px solid var(--accent)' }
          : off}
      >
        {video.screenSharing ? <MonitorX className="h-4 w-4" /> : <MonitorUp className="h-4 w-4" />}
        {video.screenSharing ? 'Stop Sharing' : 'Share Workspace'}
      </button>
    </div>
  );
}

function MicToggleButton() {
  const micEnabled = useInterviewStore((s) => s.candidateMicEnabled);
  const setCandidateMicEnabled = useInterviewStore((s) => s.setCandidateMicEnabled);
  const [toggling, setToggling] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    try {
      const actual = await toggleCandidateMic(!micEnabled);
      setCandidateMicEnabled(actual);
    } catch {
      // toggleCandidateMic already logs and returns actual state
    } finally {
      setToggling(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={toggling}
      title={micEnabled ? 'Mute your microphone' : 'Unmute your microphone'}
      aria-label={micEnabled ? 'Microphone on — click to mute' : 'Microphone off — click to unmute'}
      className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold transition hover:opacity-90"
      style={{
        background: micEnabled ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
        color: micEnabled ? 'var(--success)' : 'var(--muted)',
        border: `1px solid ${micEnabled ? 'rgba(34,197,94,0.3)' : 'rgba(148,163,184,0.2)'}`,
      }}
    >
      {micEnabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
      {micEnabled ? 'Microphone On' : 'Microphone Off'}
    </button>
  );
}

export function WorkspacePage() {
  const store = useInterviewStore();
  const startTimeRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const [roomName, setRoomName] = useState('interview-room');
  const [participantName, setParticipantName] = useState('candidate');
  const [tab, setTab] = useState<'transcript' | 'chat'>('transcript');

  const handleAudioData = useCallback((source: 'system' | 'microphone', data: ArrayBuffer) => {
    sendAudioData(source, data);
  }, []);

  const handleLiveKitStatus = useCallback((status: Record<string, unknown>) => {
    store.setLiveKitStatus(status as any);

    if (status.interviewerAudio === 'receiving') {
      store.setAudioStatus({ systemAudio: 'connected' });
    }
    if (status.candidateAudio === 'receiving') {
      store.setAudioStatus({ microphone: 'connected' });
    }
  }, []);

  useEffect(() => {
    connectWS();

    const unsubscribe = onWSMessage((msg) => {
      switch (msg.type) {
        case 'connection_state': {
          const p = msg.payload as any;
          store.setConnectionMode(p.demoMode ? 'demo' : 'live');
          store.setDemoMode(p.demoMode);
          store.setAudioStatus({ ai: p.ai && p.ai !== 'mock' ? 'connected' : 'demo' });
          break;
        }
        case 'session_state': {
          store.setSessionState((msg.payload as any).state);
          break;
        }
        case 'audio_status': {
          store.setAudioStatus(msg.payload as any);
          break;
        }
        case 'transcript': {
          const entry = msg.payload as any;
          if (entry.isFinal) {
            store.appendTranscript(entry);
          } else {
            store.updatePartialTranscript(entry);
          }
          break;
        }
        case 'session_joined': {
          store.setChatSession(msg.sessionId as string, msg.history as ChatItem[]);
          store.setChatPending(Boolean(msg.pending));
          store.setChatError(null);
          break;
        }
        case 'chat_user_message':
        case 'chat_response': {
          store.addChatMessage({
            id: msg.id as string,
            sender: msg.type === 'chat_response' ? 'ai_interviewer' : msg.sender as ChatItem['sender'],
            message: msg.message as string,
            timestamp: msg.timestamp as number,
          });
          break;
        }
        case 'chat_pending': {
          store.setChatPending(Boolean(msg.pending));
          break;
        }
        case 'chat_error': {
          store.setChatError((msg.message as string) || 'Unable to generate response');
          // The server reports whether a request is still running for the session.
          store.setChatPending(Boolean(msg.pending));
          break;
        }
        case 'question': {
          const q = msg.payload as { question: string; topic: string };
          store.setCurrentQuestion(q.question, q.topic);
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      disconnectWS();
    };
  }, []);

  const startSession = async () => {
    store.setSessionState('connecting');

    try {
      const resp = await fetch('http://localhost:3001/livekit/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomName,
          participantName,
          participantIdentity: `candidate-${Date.now()}`,
          role: 'candidate',
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || 'Failed to get token');
      }

      const { token, url, sessionId, participantKey } = await resp.json();
      joinSession(sessionId, participantKey);
      setTab('chat');

      await connectToRoom(url, token, handleAudioData, handleLiveKitStatus, store.setVideo);

      sendWSMessage('session_control', { action: 'start' });

      startTimeRef.current = Date.now();
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        useInterviewStore.setState({
          elapsed: `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`,
        });
      }, 1000);
    } catch (err) {
      console.error('[session] Start failed:', err);
      store.setSessionState('error');
    }
  };

  const stopSession = async () => {
    leaveSession();
    await disconnectFromRoom();
    sendWSMessage('session_control', { action: 'stop' });
    if (timerRef.current) clearInterval(timerRef.current);
    store.clearSession();
    store.setAudioStatus({
      systemAudio: 'disconnected',
      microphone: 'disconnected',
      stt: 'disconnected',
    });
    store.setLiveKitStatus({
      room: 'disconnected',
      interviewerAudio: 'disconnected',
      candidateAudio: 'disconnected',
      interviewerIdentity: null,
    });
  };

  const isActive = store.sessionState !== 'idle';

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--background)', color: 'var(--text)' }}>
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-3"
        style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Shield className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold">InterviewAI</div>
            <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
              {store.demoMode ? 'Demo Mode' : 'Live Mode'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {isActive && (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: 'var(--error)' }} />
              <span className="text-xs font-medium">LIVE</span>
              <span className="text-xs font-mono" style={{ color: 'var(--muted)' }}>{store.elapsed}</span>
            </div>
          )}
          <div
            className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase"
            style={{
              background: store.connectionMode === 'live' ? 'rgba(34,197,94,0.1)' : 'rgba(234,179,8,0.1)',
              color: store.connectionMode === 'live' ? 'var(--success)' : 'var(--warning)',
            }}
          >
            <StatusDot status={store.connectionMode === 'live' ? 'connected' : 'demo'} />
            {store.connectionMode === 'live' ? 'Connected' : store.connectionMode === 'demo' ? 'Demo' : 'Offline'}
          </div>
        </div>
      </header>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Transcript panel */}
        <div className="flex flex-1 flex-col overflow-hidden p-6">
          {isActive && <VideoStage />}
          {store.currentQuestion && (
            <div className="mb-4 rounded-xl p-4"
              style={{ background: 'var(--accent-soft)', border: '1px solid var(--accent)' }}>
              <div className="text-[10px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--accent)' }}>
                Current Question
              </div>
              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                {store.currentQuestion}
              </p>
            </div>
          )}
          <div className="mb-3 flex gap-1 rounded-xl p-1" role="tablist"
            style={{ background: 'var(--surface-soft)', alignSelf: 'flex-start' }}>
            {([
              ['transcript', 'Live Transcript', Radio],
              ['chat', 'Interview Chat', MessageSquare],
            ] as const).map(([key, label, Icon]) => (
              <button
                key={key}
                role="tab"
                aria-selected={tab === key}
                onClick={() => setTab(key)}
                className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition"
                style={tab === key
                  ? { background: 'var(--panel-strong)', color: 'var(--text)', boxShadow: '0 1px 3px rgba(0,0,0,0.2)' }
                  : { color: 'var(--muted)' }}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
          {tab === 'transcript' ? <TranscriptView /> : <InterviewChat />}
        </div>

        {/* Right sidebar */}
        <div className="flex w-80 flex-col gap-4 p-5 overflow-y-auto"
          style={{ borderLeft: '1px solid var(--border)', background: 'var(--panel)' }}>

          {/* Room config */}
          {!isActive && (
            <div className="space-y-3">
              <div className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--muted)' }}>
                LiveKit Room
              </div>
              <div className="space-y-2">
                <label className="block text-xs" style={{ color: 'var(--muted)' }}>Room Name</label>
                <input
                  value={roomName}
                  onChange={(e) => setRoomName(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: 'var(--surface-soft)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
              <div className="space-y-2">
                <label className="block text-xs" style={{ color: 'var(--muted)' }}>Your Name</label>
                <input
                  value={participantName}
                  onChange={(e) => setParticipantName(e.target.value)}
                  className="w-full rounded-lg px-3 py-2 text-sm"
                  style={{ background: 'var(--surface-soft)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
              </div>
            </div>
          )}

          {/* Session controls */}
          {!isActive ? (
            <button
              onClick={startSession}
              className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition hover:opacity-90"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              <Play className="h-4 w-4" />
              Start Interview
            </button>
          ) : (
            <>
              <button
                onClick={stopSession}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition hover:opacity-90"
                style={{ background: 'var(--error)', color: '#fff' }}
              >
                <Square className="h-4 w-4" />
                Stop Interview
              </button>
              <MicToggleButton />
              <CallControls />
            </>
          )}

          <AudioStatusPanel />

          {/* State */}
          <div className="space-y-2">
            <div className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--muted)' }}>
              Session State
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--text)' }}>
              <StatusDot status={isActive ? 'connected' : 'disconnected'} />
              <span className="capitalize">{store.sessionState.replace(/_/g, ' ')}</span>
            </div>
          </div>

          {/* Debug panel */}
          <DebugPanel />

          {/* Instructions */}
          {!isActive && (
            <div className="rounded-lg p-3 text-xs leading-relaxed" style={{ background: 'var(--surface-soft)', color: 'var(--muted)' }}>
              <p className="font-semibold mb-1" style={{ color: 'var(--text)' }}>How to use:</p>
              <ol className="list-decimal pl-4 space-y-1">
                <li>Enter the LiveKit room name (share with interviewer)</li>
                <li>Click "Start Interview"</li>
                <li>Wait for interviewer to join the room — you'll see their camera here</li>
                <li>Use "Share Workspace" to show this window (only this window) to the interviewer</li>
                <li>The conversation is transcribed live in this window</li>
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
