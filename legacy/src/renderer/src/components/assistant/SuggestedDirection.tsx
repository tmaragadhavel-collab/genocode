import { Compass } from 'lucide-react';
import { motion } from 'framer-motion';

type Props = { direction: string };

export function SuggestedDirection({ direction }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.1 }}
      className="rounded-2xl p-4"
      style={{
        border: '1px solid rgba(99, 102, 241, 0.2)',
        background: 'var(--accent-soft)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <Compass className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--accent)' }}>
          Suggested Direction
        </span>
      </div>
      <p className="text-sm leading-relaxed" style={{ color: 'var(--text)' }}>{direction}</p>
    </motion.div>
  );
}
