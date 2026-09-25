import { useEffect, useRef, useState } from 'react';
import { Mic, MicOff, Video, VideoOff, PhoneOff, Monitor, Users, MessageSquare } from 'lucide-react';
import { useInterviewStore, useAssistantStore } from '../stores/interviewStore';
import { connectWS, disconnectWS, onWSMessage } from '../services/wsClient';
import { motion, AnimatePresence } from 'framer-motion';

function VideoTile({ label, initials, isSelf, muted }: { label: string; initials: string; isSelf?: boolean; muted?: boolean }) {
  return (
    <div
      className="relative flex flex-col items-center justify-center rounded-2xl overflow-hidden"
      style={{
        background: isSelf ? 'linear-gradient(135deg, #1e293b 0%, #0f172a 100%)' : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        border: '1px solid var(--border)',
        aspectRatio: '16/9',
        minHeight: 200,
      }}
    >
      <div
        className="flex h-20 w-20 items-center justify-center rounded-full text-2xl font-bold"
        style={{ background: isSelf ? 'var(--accent-soft)' : 'rgba(56, 189, 248, 0.15)', color: isSelf ? 'var(--accent)' : '#38bdf8' }}
      >
        {initials}
      </div>
      <div className="mt-3 text-sm font-medium" style={{ color: 'var(--text)' }}>{label}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider" style={{ color: 'var(--muted)' }}>
        {isSelf ? 'You' : 'Interviewer'}
      </div>

      {muted && (
        <div className="absolute top-3 right-3 rounded-full p-1.5" style={{ background: 'rgba(239, 68, 68, 0.2)' }}>
          <MicOff className="h-3.5 w-3.5" style={{ color: '#ef4444' }} />
        </div>
      )}

      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-full px-2.5 py-1" style={{ background: 'rgba(0,0,0,0.5)' }}>
        <span className="dot pulse" style={{ width: 6, height: 6, background: 'var(--success)' }} />
        <span className="text-[10px] font-medium" style={{ color: '#fff' }}>Live</span>
      </div>
    </div>
  );
}

function TranscriptOverlay() {
  const { transcript } = useInterviewStore();
  const recent = transcript.slice(-4);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [transcript.length]);

  const speakerColor = (s: string) => {
    if (s === 'INTERVIEWER') return '#38bdf8';
    if (s === 'CANDIDATE') return 'var(--accent)';
    return 'var(--muted)';
  };

  return (
    <div
      ref={scrollRef}
      className="rounded-2xl p-4 space-y-2 overflow-y-auto"
      style={{ background: 'var(--panel)', border: '1px solid var(--border)', maxHeight: 280 }}
    >
      <div className="flex items-center gap-2 mb-2">
        <MessageSquare className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        <span className="text-xs font-semibold" style={{ color: 'var(--text)' }}>Live Transcript</span>
        <span className="dot pulse ml-1" style={{ width: 6, height: 6, background: 'var(--success)' }} />
      </div>
      <AnimatePresence mode="popLayout">
        {recent.map((entry, i) => (
          <motion.div
            key={`${entry.timestamp}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-xs leading-relaxed"
          >
            <span className="font-bold uppercase tracking-wide mr-2" style={{ color: speakerColor(entry.speaker), fontSize: 10 }}>
              {entry.speaker === 'INTERVIEWER' ? 'Interviewer' : entry.speaker === 'CANDIDATE' ? 'Candidate' : 'System'}
            </span>
            <span style={{ color: 'var(--text)' }}>{entry.text}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function InterviewRoom() {
  const { setQuestion, appendTranscript, setConnectionMode, connectionMode, elapsed, remaining } = useInterviewStore();
  const startTimeRef = useRef(Date.now());
  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [showTranscript, setShowTranscript] = useState(true);

  useEffect(() => {
    connectWS();

    const unsubscribe = onWSMessage((msg) => {
      switch (msg.type) {
        case 'connection_state': {
          const payload = msg.payload as { state: string; demoMode: boolean };
          setConnectionMode(payload.state as 'connected' | 'demo' | 'offline');
          break;
        }
        case 'question': {
          const q = msg.payload as { question: string; topic: string; confidence: number };
          setQuestion(q.question, q.topic, q.confidence);
          if (window.appBridge) window.appBridge.send('QUESTION_UPDATED', q);
          break;
        }
        case 'transcript': {
          const entry = msg.payload as { speaker: 'INTERVIEWER' | 'CANDIDATE' | 'SYSTEM'; text: string; timestamp: string };
          appendTranscript(entry);
          if (window.appBridge) window.appBridge.send('TRANSCRIPT_APPENDED', entry);
          break;
        }
      }
    });

    return () => { unsubscribe(); disconnectWS(); };
  }, [setQuestion, appendTranscript, setConnectionMode]);

  useEffect(() => {
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const elapsedStr = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
      const remainSecs = Math.max(0, 1800 - elapsed);
      const rMins = Math.floor(remainSecs / 60);
      const rSecs = remainSecs % 60;
      const remainStr = `${rMins.toString().padStart(2, '0')}:${rSecs.toString().padStart(2, '0')}`;
      useInterviewStore.setState({ elapsed: elapsedStr, remaining: remainStr, progress: Math.min(100, Math.round((elapsed / 1800) * 100)) });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const modeLabel = connectionMode === 'demo' ? 'Demo Mode' : connectionMode === 'connected' ? 'Connected' : 'Offline';
  const modeColor = connectionMode === 'demo' ? 'var(--warning)' : connectionMode === 'connected' ? 'var(--success)' : 'var(--muted)';

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {/* Top bar */}
      <div className="flex items-center justify-between px-6 py-3" style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel)' }}>
        <div className="flex items-center gap-4">
          <span className="text-base font-semibold">InterviewAI</span>
          <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: 'var(--success)' }}>
            <span className="dot pulse" style={{ width: 7, height: 7 }} />
            Live
          </span>
          <div className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase" style={{ background: 'var(--surface-soft)', color: modeColor }}>
            <span className="dot" style={{ width: 5, height: 5, background: modeColor, borderRadius: '50%' }} />
            {modeLabel}
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <Users className="h-3.5 w-3.5" />
            <span>2 participants</span>
          </div>
          <div className="rounded-full px-3 py-1 text-xs font-mono font-semibold" style={{ background: 'var(--surface-soft)', color: 'var(--text)' }}>
            {elapsed}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Video area */}
        <div className="flex-1 p-6">
          <div className="grid grid-cols-2 gap-4 h-full" style={{ maxHeight: 'calc(100vh - 180px)' }}>
            <VideoTile label="Dr. Sarah Chen" initials="SC" />
            <VideoTile label="Alex Morgan" initials="AM" isSelf muted={!micOn} />
          </div>
        </div>

        {/* Side transcript panel */}
        {showTranscript && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 360, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            className="flex flex-col overflow-hidden"
            style={{ borderLeft: '1px solid var(--border)', background: 'var(--panel)', width: 360 }}
          >
            <div className="px-4 py-3 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)', borderBottom: '1px solid var(--border)' }}>
              Interview Transcript
            </div>
            <div className="flex-1 overflow-y-auto p-4">
              <TranscriptOverlay />
            </div>
            <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="text-[10px]" style={{ color: 'var(--muted)' }}>
                Current Topic: <span style={{ color: 'var(--text)' }}>{useInterviewStore.getState().topic}</span>
              </div>
            </div>
          </motion.div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="flex items-center justify-center gap-4 px-6 py-4" style={{ borderTop: '1px solid var(--border)', background: 'var(--panel)' }}>
        <button
          onClick={() => setMicOn((v) => !v)}
          className="rounded-full p-3.5 transition hover:opacity-80"
          style={{ background: micOn ? 'var(--surface-soft)' : 'rgba(239, 68, 68, 0.2)', color: micOn ? 'var(--text)' : '#ef4444' }}
          title={micOn ? 'Mute microphone' : 'Unmute microphone'}
        >
          {micOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
        </button>
        <button
          onClick={() => setCamOn((v) => !v)}
          className="rounded-full p-3.5 transition hover:opacity-80"
          style={{ background: camOn ? 'var(--surface-soft)' : 'rgba(239, 68, 68, 0.2)', color: camOn ? 'var(--text)' : '#ef4444' }}
          title={camOn ? 'Turn off camera' : 'Turn on camera'}
        >
          {camOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
        </button>
        <button
          onClick={() => setShowTranscript((v) => !v)}
          className="rounded-full p-3.5 transition hover:opacity-80"
          style={{ background: showTranscript ? 'var(--accent-soft)' : 'var(--surface-soft)', color: showTranscript ? 'var(--accent)' : 'var(--text)' }}
          title="Toggle transcript"
        >
          <MessageSquare className="h-5 w-5" />
        </button>
        <button
          onClick={() => setShowTranscript((v) => !v)}
          className="rounded-full p-3.5 transition hover:opacity-80"
          style={{ background: 'var(--surface-soft)', color: 'var(--text)' }}
          title="Screen share"
        >
          <Monitor className="h-5 w-5" />
        </button>
        <button
          className="rounded-full p-3.5 transition hover:opacity-80"
          style={{ background: 'rgba(239, 68, 68, 0.9)', color: '#fff' }}
          title="Leave interview"
        >
          <PhoneOff className="h-5 w-5" />
        </button>

        <div className="ml-8 flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
          <div className="flex items-center gap-1.5">
            <span className="dot" style={{ width: 6, height: 6, background: 'var(--success)', borderRadius: '50%' }} />
            Interviewer connected
          </div>
          <div className="flex items-center gap-1.5">
            <span className="dot" style={{ width: 6, height: 6, background: 'var(--success)', borderRadius: '50%' }} />
            Candidate connected
          </div>
          <div className="flex items-center gap-1.5">
            <span className="dot pulse" style={{ width: 6, height: 6, background: 'var(--success)', borderRadius: '50%' }} />
            STT active
          </div>
        </div>
      </div>
    </div>
  );
}
