import { useEffect } from 'react';
import { useAssistantStore, useInterviewStore } from '../stores/interviewStore';
import { connectWS, disconnectWS, onWSMessage } from '../services/wsClient';
import { Shield, Mic, Monitor, Radio, Cpu, Sparkles, GripHorizontal, Minus } from 'lucide-react';

function StatusDot({ active, color }: { active: boolean; color?: string }) {
  const c = active ? (color || 'var(--success)') : 'var(--muted)';
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: c, boxShadow: active ? `0 0 4px ${c}` : 'none' }}
    />
  );
}

function ConnectionBar() {
  const audioStatus = useInterviewStore((s) => s.audioStatus);
  const livekitStatus = useInterviewStore((s) => s.livekitStatus);

  return (
    <div className="flex items-center gap-3 px-1 py-1">
      <div className="flex items-center gap-1 text-[9px]" title="Interviewer Audio">
        <Monitor className="h-2.5 w-2.5" style={{ color: 'var(--muted)' }} />
        <StatusDot active={livekitStatus.interviewerAudio === 'receiving'} color={livekitStatus.interviewerAudio === 'waiting' ? 'var(--warning)' : undefined} />
      </div>
      <div className="flex items-center gap-1 text-[9px]" title="Candidate Mic">
        <Mic className="h-2.5 w-2.5" style={{ color: 'var(--muted)' }} />
        <StatusDot active={livekitStatus.candidateAudio === 'receiving'} />
      </div>
      <div className="flex items-center gap-1 text-[9px]" title="Speech Recognition">
        <Radio className="h-2.5 w-2.5" style={{ color: 'var(--muted)' }} />
        <StatusDot active={audioStatus.stt === 'connected'} />
      </div>
      <div className="flex items-center gap-1 text-[9px]" title="AI">
        <Cpu className="h-2.5 w-2.5" style={{ color: 'var(--muted)' }} />
        <StatusDot active={audioStatus.ai === 'connected' || audioStatus.ai === 'demo'} color={audioStatus.ai === 'demo' ? 'var(--warning)' : undefined} />
      </div>
    </div>
  );
}

function StateLabel() {
  const sessionState = useInterviewStore((s) => s.sessionState);
  const isStreaming = useAssistantStore((s) => s.isStreaming);

  const labels: Record<string, { text: string; color: string }> = {
    idle: { text: 'Ready', color: 'var(--muted)' },
    connecting: { text: 'Connecting...', color: 'var(--warning)' },
    listening: { text: 'Listening', color: 'var(--success)' },
    interviewer_speaking: { text: 'Listening', color: 'var(--success)' },
    processing_question: { text: 'Processing...', color: 'var(--accent)' },
    ai_thinking: { text: 'AI Thinking...', color: 'var(--accent)' },
    ai_streaming: { text: 'Generating...', color: 'var(--accent)' },
    waiting_for_next_question: { text: 'Listening', color: 'var(--success)' },
    error: { text: 'Error', color: 'var(--error, #ef4444)' },
  };

  const label = labels[sessionState] || labels.idle;

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`h-2 w-2 rounded-full ${sessionState === 'listening' || sessionState === 'interviewer_speaking' || sessionState === 'waiting_for_next_question' ? 'animate-pulse' : ''}`}
        style={{ background: label.color }}
      />
      <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: label.color }}>
        {isStreaming ? 'Generating...' : label.text}
      </span>
    </div>
  );
}

export function AssistantPage() {
  const {
    protectionEnabled,
    currentQuestion,
    answerDirection,
    keyPoints,
    contextInfo,
    followUp,
    isStreaming,
    setProtection,
    handleStreamChunk,
    setCurrentQuestion,
  } = useAssistantStore();

  useEffect(() => {
    connectWS();

    const unsubscribe = onWSMessage((msg) => {
      switch (msg.type) {
        case 'connection_state': {
          const p = msg.payload as any;
          useInterviewStore.getState().setConnectionMode(p.demoMode ? 'demo' : 'live');
          useInterviewStore.getState().setDemoMode(p.demoMode);
          useInterviewStore.getState().setAudioStatus({
            ai: p.ai === 'openai' ? 'connected' : 'demo',
          });
          break;
        }
        case 'session_state': {
          useInterviewStore.getState().setSessionState((msg.payload as any).state);
          break;
        }
        case 'audio_status': {
          useInterviewStore.getState().setAudioStatus(msg.payload as any);
          break;
        }
        case 'transcript': {
          const entry = msg.payload as any;
          if (entry.isFinal) {
            useInterviewStore.getState().appendTranscript(entry);
          }
          break;
        }
        case 'question': {
          const q = msg.payload as { question: string; topic: string };
          setCurrentQuestion(q.question);
          useInterviewStore.getState().setCurrentQuestion(q.question, q.topic);
          break;
        }
        case 'assistant_stream': {
          handleStreamChunk(msg.payload as any);
          break;
        }
      }
    });

    return () => {
      unsubscribe();
      disconnectWS();
    };
  }, [handleStreamChunk, setCurrentQuestion]);

  useEffect(() => {
    if (!window.appBridge) return;
    const listener = window.appBridge.on('PROTECTION_STATE_CHANGED', (...args: unknown[]) => {
      const payload = args[0] as { enabled: boolean };
      if (payload !== undefined) setProtection(payload.enabled);
    });
    return () => { window.appBridge.off('PROTECTION_STATE_CHANGED', listener); };
  }, [setProtection]);

  const hasContent = answerDirection || keyPoints.length > 0 || contextInfo || followUp;
  const sessionState = useInterviewStore((s) => s.sessionState);
  const isActive = sessionState !== 'idle';

  return (
    <div className="flex h-screen flex-col" style={{ background: 'var(--background)', color: 'var(--text)' }}>
      {/* Drag handle + header */}
      <div
        className="drag-region flex items-center justify-between px-4 py-2.5"
        style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--panel)',
        }}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal className="h-3.5 w-3.5" style={{ color: 'var(--muted)' }} />
          <Sparkles className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
          <span className="text-xs font-bold">AI Interview Copilot</span>
        </div>
        <div className="no-drag flex items-center gap-2">
          <StateLabel />
          {protectionEnabled && (
            <div className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[9px] font-bold uppercase"
              style={{ background: 'rgba(34,197,94,0.1)', color: 'var(--success)' }}>
              <Shield className="h-2.5 w-2.5" />
              Protected
            </div>
          )}
          <button
            onClick={() => window.appBridge?.toggleAssistant(false)}
            className="rounded p-1 transition hover:opacity-70"
            style={{ color: 'var(--muted)' }}
          >
            <Minus className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* Connection status bar */}
      <div className="px-4 py-1" style={{ borderBottom: '1px solid var(--border)', background: 'var(--panel-strong, var(--panel))' }}>
        <ConnectionBar />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {/* Current Question */}
        {currentQuestion ? (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: '#60a5fa' }}>
              Current Question
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-soft)', border: '1px solid rgba(96,165,250,0.2)' }}>
              <p className="text-sm font-medium leading-relaxed">{currentQuestion}</p>
            </div>
          </section>
        ) : isActive ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Radio className="h-6 w-6 mb-2 animate-pulse" style={{ color: 'var(--accent)' }} />
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Listening for interviewer questions...
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Sparkles className="h-6 w-6 mb-2" style={{ color: 'var(--muted)' }} />
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Start the interview session from the workspace window.
            </p>
          </div>
        )}

        {/* AI Response */}
        {answerDirection && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--accent)' }}>
              AI Response
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-soft)' }}>
              <p className="text-sm leading-relaxed">{answerDirection}</p>
              {isStreaming && <span className="inline-block w-1 h-3 ml-0.5 animate-pulse" style={{ background: 'var(--accent)' }} />}
            </div>
          </section>
        )}

        {/* Key Points */}
        {keyPoints.length > 0 && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--success)' }}>
              Key Points
            </div>
            <div className="rounded-lg p-3 space-y-1.5" style={{ background: 'var(--surface-soft)' }}>
              {keyPoints.map((point, i) => (
                <div key={i} className="flex items-start gap-2 text-sm">
                  <span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} />
                  <span className="leading-relaxed">{point}</span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Context */}
        {contextInfo && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'var(--warning)' }}>
              Context
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-soft)' }}>
              <p className="text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>{contextInfo}</p>
            </div>
          </section>
        )}

        {/* Follow-up */}
        {followUp && (
          <section>
            <div className="text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: '#a78bfa' }}>
              Likely Follow-up
            </div>
            <div className="rounded-lg p-3" style={{ background: 'var(--surface-soft)', border: '1px solid rgba(167,139,250,0.2)' }}>
              <p className="text-xs italic leading-relaxed">{followUp}</p>
            </div>
          </section>
        )}

        {/* Privacy notice */}
        {!hasContent && !isActive && (
          <div className="mt-4 rounded-lg p-3 text-[10px] leading-relaxed" style={{ background: 'var(--surface-soft)', color: 'var(--muted)' }}>
            <p className="font-semibold mb-1" style={{ color: 'var(--text)' }}>Privacy</p>
            <p>This window is protected from screen capture. The interviewer cannot see it when you share your screen.</p>
            <p className="mt-1"><strong>Ctrl+Shift+P</strong> — Toggle protection</p>
            <p><strong>Ctrl+Shift+H</strong> — Hide/show this window</p>
          </div>
        )}
      </div>
    </div>
  );
}
