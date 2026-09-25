import { Bot, User } from 'lucide-react';
import { motion } from 'framer-motion';

type Props = { role: 'user' | 'assistant'; text: string };

export function AIMessage({ role, text }: Props) {
  const isAssistant = role === 'assistant';

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className={`flex gap-2.5 ${isAssistant ? '' : 'flex-row-reverse'}`}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
        style={{
          background: isAssistant ? 'var(--accent-soft)' : 'var(--surface-soft)',
          color: isAssistant ? 'var(--accent)' : 'var(--muted)',
        }}
      >
        {isAssistant ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>
      <div
        className="rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed"
        style={{
          maxWidth: '85%',
          background: isAssistant ? 'var(--accent-soft)' : 'var(--surface-soft)',
          border: `1px solid ${isAssistant ? 'rgba(99, 102, 241, 0.15)' : 'var(--border)'}`,
          color: 'var(--text)',
        }}
      >
        {text}
      </div>
    </motion.div>
  );
}
