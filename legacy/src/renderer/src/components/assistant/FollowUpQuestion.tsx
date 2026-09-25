import { MessageCircleQuestion } from 'lucide-react';
import { motion } from 'framer-motion';

type Props = { followUp: string };

export function FollowUpQuestion({ followUp }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.15 }}
      className="rounded-2xl p-4"
      style={{
        border: '1px solid rgba(139, 92, 246, 0.2)',
        background: 'rgba(139, 92, 246, 0.06)',
      }}
    >
      <div className="mb-2 flex items-center gap-2">
        <MessageCircleQuestion className="h-3.5 w-3.5" style={{ color: '#a78bfa' }} />
        <span className="text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: '#a78bfa' }}>
          Possible Follow-up
        </span>
      </div>
      <p className="text-sm italic leading-relaxed" style={{ color: 'var(--text)' }}>&ldquo;{followUp}&rdquo;</p>
    </motion.div>
  );
}
