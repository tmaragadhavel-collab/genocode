import { CheckCircle2 } from 'lucide-react';
import { motion } from 'framer-motion';

type Props = { points: string[] };

export function KeyPoints({ points }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.05 }}
      className="rounded-2xl p-4"
      style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
    >
      <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--accent)' }}>
        Key Points
      </div>
      <ul className="space-y-2.5">
        {points.map((point, i) => (
          <motion.li
            key={i}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.05 * i }}
            className="flex items-start gap-2.5 text-sm"
            style={{ color: 'var(--text)' }}
          >
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: 'var(--success)' }} />
            <span>{point}</span>
          </motion.li>
        ))}
      </ul>
    </motion.div>
  );
}
