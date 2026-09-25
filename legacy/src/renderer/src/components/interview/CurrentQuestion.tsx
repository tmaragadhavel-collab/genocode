import { Pin, Copy, MoreHorizontal, Brain } from 'lucide-react';
import { useInterviewStore } from '../../stores/interviewStore';
import { motion } from 'framer-motion';

export function CurrentQuestion() {
  const { question, topic, difficulty, time } = useInterviewStore();

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="soft-card overflow-hidden p-6"
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: 'var(--accent-soft)' }}>
            <Brain className="h-4 w-4" style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Current Question</h2>
            <span className="text-xs" style={{ color: 'var(--success)' }}>Question detected</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-lg p-2 transition hover:opacity-70" style={{ color: 'var(--muted)' }} title="Pin question">
            <Pin className="h-3.5 w-3.5" />
          </button>
          <button
            className="rounded-lg p-2 transition hover:opacity-70"
            style={{ color: 'var(--muted)' }}
            title="Copy question"
            onClick={() => navigator.clipboard?.writeText(question)}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
          <button className="rounded-lg p-2 transition hover:opacity-70" style={{ color: 'var(--muted)' }} title="More options">
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <blockquote
        className="mb-5 rounded-2xl px-5 py-4 text-base font-medium leading-relaxed"
        style={{
          border: '1px solid rgba(99, 102, 241, 0.2)',
          background: 'var(--accent-soft)',
          color: 'var(--text)',
        }}
      >
        &ldquo;{question}&rdquo;
      </blockquote>

      <div className="flex flex-wrap items-center gap-3">
        {[
          { label: 'Topic', value: topic },
          { label: 'Difficulty', value: difficulty },
          { label: 'Time', value: time },
        ].map(({ label, value }) => (
          <div
            key={label}
            className="flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
            style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)', color: 'var(--muted)' }}
          >
            <span className="font-semibold" style={{ color: 'var(--text)' }}>{label}:</span> {value}
          </div>
        ))}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="wave" style={{ width: 60 }}>
          <span /><span /><span /><span />
        </div>
        <span className="text-xs" style={{ color: 'var(--muted)' }}>Active</span>
      </div>
    </motion.div>
  );
}
