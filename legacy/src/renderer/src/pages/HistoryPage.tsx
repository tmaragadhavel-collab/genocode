import { useEffect, useState } from 'react';
import { History, Clock, MessageSquare, Brain, ChevronRight, ArrowLeft } from 'lucide-react';
import { WorkspaceShell } from '../components/layout/WorkspaceShell';
import { motion, AnimatePresence } from 'framer-motion';

interface InterviewSummary {
  _id: string;
  title: string;
  role: string;
  interviewType: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  demoMode: boolean;
  currentTopic: string;
  questionCount: number;
}

interface TranscriptItem {
  speaker: string;
  text: string;
  timestamp: string;
}

interface InsightItem {
  insight: string;
  keyPoints: string[];
  suggestedDirection: string;
  followUp: string;
  topic: string;
  createdAt: string;
}

const API = 'http://localhost:3001';

export function HistoryPage() {
  const [interviews, setInterviews] = useState<InterviewSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [insights, setInsights] = useState<InsightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [persistence, setPersistence] = useState('');

  useEffect(() => {
    fetch(`${API}/api/interviews`)
      .then((r) => r.json())
      .then((data) => {
        setInterviews(data.interviews || []);
        setPersistence(data.persistence || 'memory');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const loadDetails = async (id: string) => {
    setSelected(id);
    try {
      const res = await fetch(`${API}/api/interviews/${id}/history`);
      const data = await res.json();
      setTranscripts(data.transcripts || []);
      setInsights(data.insights || []);
    } catch {
      setTranscripts([]);
      setInsights([]);
    }
  };

  const speakerColor = (s: string) => {
    if (s === 'INTERVIEWER') return '#38bdf8';
    if (s === 'CANDIDATE') return 'var(--accent)';
    return 'var(--muted)';
  };

  const formatDate = (d: string) => {
    try {
      return new Date(d).toLocaleString();
    } catch {
      return d;
    }
  };

  const duration = (start: string, end?: string) => {
    if (!end) return 'In progress';
    const ms = new Date(end).getTime() - new Date(start).getTime();
    const mins = Math.floor(ms / 60000);
    return `${mins} min`;
  };

  if (selected) {
    const interview = interviews.find((i) => i._id === selected);
    return (
      <WorkspaceShell>
        <div className="space-y-6">
          <button
            onClick={() => setSelected(null)}
            className="flex items-center gap-2 text-sm transition hover:opacity-80"
            style={{ color: 'var(--accent)' }}
          >
            <ArrowLeft className="h-4 w-4" />
            Back to History
          </button>

          {interview && (
            <div className="soft-card p-6">
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>{interview.title}</h2>
              <div className="mt-2 flex flex-wrap gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                <span>{interview.role}</span>
                <span>{interview.interviewType}</span>
                <span>{formatDate(interview.startedAt)}</span>
                <span>{duration(interview.startedAt, interview.endedAt)}</span>
                <span className="badge" style={{ background: interview.status === 'active' ? 'rgba(34,197,94,0.1)' : 'var(--surface-soft)', color: interview.status === 'active' ? 'var(--success)' : 'var(--muted)' }}>
                  {interview.status}
                </span>
                {interview.demoMode && (
                  <span className="badge" style={{ background: 'rgba(234,179,8,0.1)', color: 'var(--warning)' }}>Demo</span>
                )}
              </div>
            </div>
          )}

          {/* Transcript */}
          <div className="soft-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Transcript ({transcripts.length} segments)</h3>
            </div>
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {transcripts.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>No transcript data available.</p>
              ) : (
                transcripts.map((t, i) => (
                  <div key={i} className="flex gap-2 text-xs">
                    <span className="font-bold uppercase shrink-0" style={{ color: speakerColor(t.speaker), width: 80 }}>
                      {t.speaker === 'INTERVIEWER' ? 'Interviewer' : t.speaker === 'CANDIDATE' ? 'Candidate' : 'System'}
                    </span>
                    <span style={{ color: 'var(--text)' }}>{t.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* AI Insights */}
          <div className="soft-card p-6">
            <div className="flex items-center gap-2 mb-4">
              <Brain className="h-4 w-4" style={{ color: 'var(--warning)' }} />
              <h3 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>AI Insights ({insights.length})</h3>
            </div>
            <div className="space-y-4 max-h-[400px] overflow-y-auto">
              {insights.length === 0 ? (
                <p className="text-xs" style={{ color: 'var(--muted)' }}>No AI insights recorded.</p>
              ) : (
                insights.map((ins, i) => (
                  <div key={i} className="rounded-xl p-4" style={{ background: 'var(--surface-soft)', border: '1px solid var(--border)' }}>
                    <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--warning)' }}>
                      {ins.topic}
                    </div>
                    <p className="text-xs mb-2" style={{ color: 'var(--text)' }}>{ins.insight}</p>
                    {ins.keyPoints.length > 0 && (
                      <ul className="space-y-1 mb-2">
                        {ins.keyPoints.map((p, j) => (
                          <li key={j} className="text-xs flex gap-1.5" style={{ color: 'var(--muted)' }}>
                            <span style={{ color: 'var(--accent)' }}>-</span> {p}
                          </li>
                        ))}
                      </ul>
                    )}
                    {ins.suggestedDirection && (
                      <p className="text-xs italic" style={{ color: 'var(--muted)' }}>{ins.suggestedDirection}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </WorkspaceShell>
    );
  }

  return (
    <WorkspaceShell>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl" style={{ background: 'var(--accent-soft)' }}>
              <History className="h-5 w-5" style={{ color: 'var(--accent)' }} />
            </div>
            <div>
              <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Interview History</h1>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                Persistence: <span style={{ color: persistence === 'mongodb' ? 'var(--success)' : 'var(--warning)' }}>{persistence === 'mongodb' ? 'MongoDB' : 'Demo Mode (In-Memory)'}</span>
              </p>
            </div>
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--muted)' }}>Loading interviews...</div>
        ) : interviews.length === 0 ? (
          <div className="soft-card flex flex-col items-center justify-center py-16 text-center">
            <History className="h-12 w-12 mb-4" style={{ color: 'var(--muted)', opacity: 0.4 }} />
            <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>No interviews yet</p>
            <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Start an interview from the Interview Room to see history here.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence>
              {interviews.map((interview) => (
                <motion.button
                  key={interview._id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  onClick={() => loadDetails(interview._id)}
                  className="soft-card flex w-full items-center justify-between p-5 text-left transition hover:opacity-90"
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{interview.title}</span>
                      {interview.demoMode && (
                        <span className="rounded-full px-2 py-0.5 text-[9px] font-semibold" style={{ background: 'rgba(234,179,8,0.1)', color: 'var(--warning)' }}>Demo</span>
                      )}
                      <span
                        className="rounded-full px-2 py-0.5 text-[9px] font-semibold"
                        style={{
                          background: interview.status === 'active' ? 'rgba(34,197,94,0.1)' : 'var(--surface-soft)',
                          color: interview.status === 'active' ? 'var(--success)' : 'var(--muted)',
                        }}
                      >
                        {interview.status}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-4 text-xs" style={{ color: 'var(--muted)' }}>
                      <span>{interview.role}</span>
                      <span className="flex items-center gap-1"><Clock className="h-3 w-3" />{formatDate(interview.startedAt)}</span>
                      <span>{duration(interview.startedAt, interview.endedAt)}</span>
                      {interview.currentTopic && <span>Topic: {interview.currentTopic}</span>}
                      <span>{interview.questionCount} questions</span>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0" style={{ color: 'var(--muted)' }} />
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}
