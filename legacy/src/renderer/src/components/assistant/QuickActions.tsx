import { Sparkles, Eye, BookOpen, ClipboardList, Focus, PauseCircle, PlayCircle } from 'lucide-react';
import { useAssistantStore } from '../../stores/interviewStore';

import { motion } from 'framer-motion';

export function QuickActions() {
  const { paused, focusMode, togglePause, toggleFocus, addChatMessage } = useAssistantStore();

  const handleShowHint = async () => {
    addChatMessage({ role: 'assistant', text: 'Hint: Focus on explaining the intuition behind convolution — how a sliding filter detects local patterns (edges, textures) and builds up to complex features through depth.' });
  };

  const handleExplainMore = async () => {
    addChatMessage({ role: 'assistant', text: 'Expanding: Pooling layers serve three purposes — they reduce spatial dimensions (lowering computation), provide a degree of translation invariance, and help prevent overfitting by abstracting features. Max pooling retains the strongest activations in each region.' });
  };

  const handleSummarize = async () => {
    addChatMessage({ role: 'assistant', text: 'Summary so far: The interviewer is exploring your knowledge of CNN architecture — convolution for feature extraction, pooling for dimensionality reduction, and hierarchical representation learning. You\'ve covered the basics well. Next, be ready for questions about practical trade-offs.' });
  };

  const handleAskAI = () => {
    const chatInput = document.querySelector<HTMLInputElement>('input[placeholder="Ask your AI assistant..."]');
    if (chatInput) {
      chatInput.focus();
    }
  };

  const actions = [
    { label: 'Ask AI', icon: Sparkles, color: 'var(--accent)', onClick: handleAskAI },
    { label: 'Show Hint', icon: Eye, color: 'var(--warning)', onClick: handleShowHint },
    { label: 'Explain More', icon: BookOpen, color: '#38bdf8', onClick: handleExplainMore },
    { label: 'Summarize', icon: ClipboardList, color: 'var(--success)', onClick: handleSummarize },
    {
      label: focusMode ? 'Exit Focus' : 'Focus Mode',
      icon: Focus,
      color: '#a78bfa',
      onClick: toggleFocus,
    },
    {
      label: paused ? 'Resume' : 'Pause',
      icon: paused ? PlayCircle : PauseCircle,
      color: paused ? 'var(--success)' : '#f43f5e',
      onClick: togglePause,
    },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.2 }}
    >
      <div className="mb-2 text-[10px] font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--muted)' }}>
        Quick Actions
      </div>
      <div className="grid grid-cols-3 gap-2">
        {actions.map((action) => (
          <button
            key={action.label}
            onClick={action.onClick}
            className="flex flex-col items-center gap-1.5 rounded-xl p-3 text-center transition active:scale-95"
            style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-soft)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-soft)'; }}
          >
            <action.icon className="h-4 w-4" style={{ color: action.color }} />
            <span className="text-[10px] font-medium" style={{ color: 'var(--text)' }}>{action.label}</span>
          </button>
        ))}
      </div>
    </motion.div>
  );
}
