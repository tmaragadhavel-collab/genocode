import { Activity, CheckCircle2 } from 'lucide-react';
import { useAssistantStore, useInterviewStore } from '../../stores/interviewStore';
import { motion } from 'framer-motion';

export function ContextIndicator() {
  const { confidence, topic } = useInterviewStore();
  const { contextSignals, subtopic, interviewStage } = useAssistantStore();

  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (confidence / 100) * circumference;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.25 }}
      className="rounded-2xl p-4"
      style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
    >
      <div className="mb-3 flex items-center gap-2">
        <Activity className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--accent)' }}>
          Context Awareness
        </span>
      </div>

      <div className="mb-4 flex items-center gap-4">
        <div className="relative flex shrink-0 items-center justify-center">
          <svg width="84" height="84" className="-rotate-90">
            <circle cx="42" cy="42" r={radius} fill="none" stroke="var(--border)" strokeWidth="5" />
            <motion.circle
              cx="42" cy="42" r={radius} fill="none"
              stroke="var(--accent)"
              strokeWidth="5" strokeLinecap="round"
              strokeDasharray={circumference}
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 1.2, ease: 'easeOut' }}
            />
          </svg>
          <span className="absolute text-lg font-bold" style={{ color: 'var(--text)' }}>{confidence}%</span>
        </div>

        <div className="space-y-1.5">
          {contextSignals.map((sig) => (
            <div key={sig.label} className="flex items-center gap-2 text-xs">
              <CheckCircle2
                className="h-3 w-3"
                style={{ color: sig.active ? 'var(--success)' : 'var(--muted)', opacity: sig.active ? 1 : 0.4 }}
              />
              <span style={{ color: sig.active ? 'var(--text)' : 'var(--muted)' }}>{sig.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2 rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        {[
          { label: 'Detected Topic', value: topic },
          { label: 'Subtopic', value: subtopic },
          { label: 'Interview Stage', value: interviewStage },
        ].map(({ label, value }) => (
          <div key={label} className="flex items-center justify-between text-xs">
            <span style={{ color: 'var(--muted)' }}>{label}</span>
            <span className="font-semibold" style={{ color: 'var(--text)' }}>{value}</span>
          </div>
        ))}
      </div>
    </motion.div>
  );
}
