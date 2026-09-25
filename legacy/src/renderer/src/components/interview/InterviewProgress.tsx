import { CheckCircle2, Circle, ArrowRight, Clock, ListChecks } from 'lucide-react';
import { useInterviewStore } from '../../stores/interviewStore';
import { motion } from 'framer-motion';

export function InterviewProgress() {
  const { progress, topics, elapsed, remaining } = useInterviewStore();

  const statusIcon = (status: string) => {
    switch (status) {
      case 'done':
        return <CheckCircle2 className="h-4 w-4" style={{ color: 'var(--success)' }} />;
      case 'current':
        return <ArrowRight className="h-4 w-4" style={{ color: 'var(--accent)' }} />;
      default:
        return <Circle className="h-4 w-4" style={{ color: 'var(--muted)', opacity: 0.5 }} />;
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, delay: 0.16 }}
      className="soft-card p-6"
    >
      <div className="mb-4 flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-xl" style={{ background: 'rgba(245, 158, 11, 0.12)' }}>
          <ListChecks className="h-4 w-4" style={{ color: 'var(--warning)' }} />
        </div>
        <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Interview Progress</h2>
      </div>

      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>Overall Progress</span>
          <span className="font-semibold" style={{ color: 'var(--text)' }}>{progress}%</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--surface-soft)' }}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg, var(--accent), #a78bfa)' }}
            initial={{ width: 0 }}
            animate={{ width: `${progress}%` }}
            transition={{ duration: 1, ease: 'easeOut' }}
          />
        </div>
      </div>

      <div className="mb-4 space-y-1">
        {topics.map((t) => (
          <div
            key={t.label}
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm transition"
            style={{
              background: t.status === 'current' ? 'var(--accent-soft)' : 'transparent',
              color: t.status === 'current' ? 'var(--accent)' : t.status === 'done' ? 'var(--success)' : 'var(--muted)',
              fontWeight: t.status === 'current' ? 500 : 400,
            }}
          >
            {statusIcon(t.status)}
            <span>{t.label}</span>
          </div>
        ))}
      </div>

      <div
        className="flex items-center gap-4 rounded-xl px-4 py-3"
        style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
      >
        <Clock className="h-4 w-4" style={{ color: 'var(--muted)' }} />
        <div className="flex flex-1 items-center justify-between text-xs">
          <div>
            <span style={{ color: 'var(--muted)' }}>Elapsed: </span>
            <span className="font-semibold" style={{ color: 'var(--text)' }}>{elapsed}</span>
          </div>
          <div>
            <span style={{ color: 'var(--muted)' }}>Remaining: </span>
            <span className="font-semibold" style={{ color: 'var(--text)' }}>{remaining}</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
