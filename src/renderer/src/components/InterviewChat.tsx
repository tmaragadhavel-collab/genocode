import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Bot, Send, AlertCircle, MessageSquare } from 'lucide-react';
import { useInterviewStore, type ChatItem } from '../stores/interviewStore';
import { sendChatMessage } from '../services/wsClient';

const MAX_LENGTH = 2000;

const SENDER_LABEL: Record<ChatItem['sender'], string> = {
  candidate: 'You',
  interviewer: 'Interviewer',
  ai_interviewer: 'AI Interviewer',
};

function Bubble({ item }: { item: ChatItem }) {
  const mine = item.sender === 'candidate';
  const ai = item.sender === 'ai_interviewer';
  return (
    <div className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <div
        className="max-w-[85%] rounded-xl px-3 py-2"
        style={{
          background: mine ? 'var(--accent-soft)' : 'var(--surface-soft)',
          border: `1px solid ${mine ? 'var(--accent)' : 'var(--border)'}`,
        }}
      >
        <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider"
          style={{ color: ai ? 'var(--accent)' : mine ? 'var(--accent)' : '#60a5fa' }}>
          {ai && <Bot className="h-3 w-3" />}
          {SENDER_LABEL[item.sender]}
          <span className="font-normal normal-case tracking-normal" style={{ color: 'var(--muted)' }}>
            {new Date(item.timestamp).toLocaleTimeString('en-US', { hour12: false })}
          </span>
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed" style={{ color: 'var(--text)' }}>
          {item.message}
        </p>
      </div>
    </div>
  );
}

export function InterviewChat() {
  const sessionId = useInterviewStore((s) => s.chatSessionId);
  const messages = useInterviewStore((s) => s.chatMessages);
  const pending = useInterviewStore((s) => s.chatPending);
  const error = useInterviewStore((s) => s.chatError);
  const setChatError = useInterviewStore((s) => s.setChatError);
  const setChatPending = useInterviewStore((s) => s.setChatPending);
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pending]);

  const text = draft.trim();
  const canSend = !!sessionId && !pending && text.length > 0 && text.length <= MAX_LENGTH;

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend || !sessionId) return;
    if (!sendChatMessage(sessionId, 'candidate', text)) {
      setChatError('Not connected to the interview server. Reconnecting…');
      return;
    }
    // Lock immediately; the server's chat_pending / chat_error events take over from here.
    setChatPending(true);
    setChatError(null);
    setDraft('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 space-y-3 overflow-y-auto pr-1" style={{ scrollbarGutter: 'stable' }}>
        {messages.length === 0 && !pending ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <MessageSquare className="mb-3 h-8 w-8" style={{ color: 'var(--muted)' }} />
            <p className="text-sm" style={{ color: 'var(--muted)' }}>
              {sessionId
                ? 'Say hello to start the interview chat.'
                : 'Start the interview to open the chat.'}
            </p>
          </div>
        ) : (
          messages.map((m) => <Bubble key={m.id} item={m} />)
        )}
        {pending && (
          <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--muted)' }} role="status">
            <Bot className="h-4 w-4 animate-pulse" style={{ color: 'var(--accent)' }} />
            AI Interviewer is thinking…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && (
        <div className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs" role="alert"
          style={{ background: 'rgba(239,68,68,0.1)', color: 'var(--error)' }}>
          <AlertCircle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      )}

      <form onSubmit={submit} className="mt-3 flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!sessionId}
          rows={2}
          maxLength={MAX_LENGTH}
          placeholder={sessionId ? 'Type your message… (Enter to send)' : 'Start the interview to chat'}
          aria-label="Chat message"
          className="flex-1 resize-none rounded-xl px-3 py-2 text-sm outline-none"
          style={{ background: 'var(--surface-soft)', border: '1px solid var(--border)', color: 'var(--text)' }}
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Send message"
          className="flex h-10 items-center gap-1.5 rounded-xl px-4 text-sm font-semibold transition hover:opacity-90 disabled:opacity-40"
          style={{ background: 'var(--accent)', color: '#fff' }}
        >
          <Send className="h-4 w-4" />
          Send
        </button>
      </form>
      {text.length > MAX_LENGTH * 0.9 && (
        <div className="mt-1 text-right text-[10px]" style={{ color: 'var(--muted)' }}>
          {text.length}/{MAX_LENGTH}
        </div>
      )}
    </div>
  );
}
