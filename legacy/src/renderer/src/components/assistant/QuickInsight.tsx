import { Lightbulb } from 'lucide-react';
import { motion } from 'framer-motion';

type Props = { insight: string };

export function QuickInsight({ insight }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="rounded-2xl p-4"
      style={{
        border: '1px solid rgba(245, 158, 11, 0.2)',
        background: 'rgba(245, 158, 11, 0.06)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Lightbulb className="h-3.5 w-3.5" style={{ color: 'var(--warning)' }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--warning)' }}>
          Quick Insight
        </span>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{insight}</p>
    </motion.div>
  );
}
