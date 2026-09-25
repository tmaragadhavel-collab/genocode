import { Mic, MessageSquare } from 'lucide-react';
import { useInterviewStore } from '../../stores/interviewStore';
import { motion, AnimatePresence } from 'framer-motion';
import { useEffect, useRef } from 'react';

export function LiveTranscript() {
  const { transcript } = useInterviewStore();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [transcript.length]);

  const speakerConfig = (speaker: string) => {
    switch (speaker) {
      case 'INTERVIEWER':
        return { label: 'Interviewer', color: '#38bdf8', bg: 'rgba(56, 189, 248, 0.06)', border: 'rgba(56, 189, 248, 0.15)' };
      case 'CANDIDATE':
        return { label: 'Candidate', color: 'var(--accent)', bg: 'var(--accent-soft)', border: 'rgba(99, 102, 241, 0.15)' };
      default:
        return { label: 'System', color: 'var(--muted)', bg: 'var(--surface-soft)', border: 'var(--border)' };
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.08 }}
      className="soft-card flex flex-col p-6"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: 'rgba(56, 189, 248, 0.12)' }}>
            <MessageSquare className="h-4 w-4" style={{ color: '#38bdf8' }} />
          </div>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Live Transcript</h2>
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--success)' }}>
              <span className="dot pulse" style={{ width: 6, height: 6 }} />
              Listening...
            </span>
          </div>
        </div>
      </div>

      <div ref={scrollRef} className="space-y-3 overflow-y-auto" style={{ maxHeight: 320 }}>
        <AnimatePresence mode="popLayout">
          {transcript.map((entry, i) => {
            const cfg = speakerConfig(entry.speaker);
            return (
              <motion.div
                key={`${entry.timestamp}-${i}`}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="rounded-2xl p-4"
                style={{ background: cfg.bg, border: `1px solid ${cfg.border}` }}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-[0.15em]" style={{ color: cfg.color }}>
                    {cfg.label}
                  </span>
                  <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{entry.timestamp}</span>
                </div>
                <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{entry.text}</p>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div
        className="mt-4 flex items-center gap-3 rounded-xl px-4 py-2.5"
        style={{
          border: '1px solid rgba(34, 197, 94, 0.2)',
          background: 'rgba(34, 197, 94, 0.06)',
        }}
      >
        <Mic className="h-4 w-4 pulse" style={{ color: 'var(--success)' }} />
        <span className="text-xs" style={{ color: 'var(--success)' }}>Listening...</span>
        <div className="wave ml-auto" style={{ width: 40, height: 14 }}>
          <span style={{ background: 'var(--success)' }} />
          <span style={{ background: 'var(--success)' }} />
          <span style={{ background: 'var(--success)' }} />
          <span style={{ background: 'var(--success)' }} />
        </div>
      </div>
    </motion.div>
  );
}
