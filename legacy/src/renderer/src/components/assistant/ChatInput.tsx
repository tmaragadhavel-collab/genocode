import { useState, useCallback } from 'react';
import { Send, Mic, Paperclip } from 'lucide-react';
import { useAssistantStore } from '../../stores/interviewStore';
import { mockAI } from '../../services/mockAIService';

export function ChatInput() {
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const addChatMessage = useAssistantStore((s) => s.addChatMessage);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;

    addChatMessage({ role: 'user', text });
    setInput('');
    setLoading(true);

    try {
      const response = await mockAI.getResponse(text);
      addChatMessage({ role: 'assistant', text: response });
    } finally {
      setLoading(false);
    }
  }, [input, loading, addChatMessage]);

  return (
    <div className="px-3 py-3" style={{ borderTop: '1px solid var(--border)', background: 'var(--panel-strong)' }}>
      <div
        className="flex items-center gap-2 rounded-2xl px-3 py-2"
        style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
      >
        <button
          className="shrink-0 rounded-lg p-1.5 transition hover:opacity-70"
          style={{ color: 'var(--muted)' }}
          title="Attach context"
        >
          <Paperclip className="h-4 w-4" />
        </button>
        <input
          className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
          style={{ color: 'var(--text)' }}
          placeholder="Ask your AI assistant..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={loading}
        />
        <button
          className="shrink-0 rounded-lg p-1.5 transition hover:opacity-70"
          style={{ color: 'var(--muted)' }}
          title="Voice input"
        >
          <Mic className="h-4 w-4" />
        </button>
        <button
          onClick={handleSend}
          disabled={!input.trim() || loading}
          className="shrink-0 rounded-xl p-2 text-white transition disabled:opacity-40"
          style={{ background: 'var(--accent)' }}
          title="Send message"
        >
          <Send className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
