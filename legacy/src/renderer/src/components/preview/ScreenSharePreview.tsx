import { Monitor, Eye, EyeOff, AlertTriangle } from 'lucide-react';
import { useAssistantStore } from '../../stores/interviewStore';
import { motion, AnimatePresence } from 'framer-motion';

export function ScreenSharePreview() {
  const { previewOpen, protectionEnabled, togglePreview } = useAssistantStore();

  return (
    <div>
      <button
        onClick={togglePreview}
        className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-xs font-medium transition"
        style={{
          border: '1px solid var(--border)',
          background: 'var(--surface-soft)',
          color: 'var(--text)',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--accent-soft)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-soft)'; }}
      >
        <Monitor className="h-3.5 w-3.5" style={{ color: 'var(--accent)' }} />
        Screen-Share Preview
        <span className="ml-auto text-[10px]" style={{ color: 'var(--muted)' }}>
          {previewOpen ? 'Hide' : 'Show'}
        </span>
      </button>

      <AnimatePresence>
        {previewOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid grid-cols-2 gap-2">
              <div className="rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
                <div className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em]" style={{ color: 'var(--accent)' }}>
                  <Eye className="h-3 w-3" />
                  What You See
                </div>
                <div className="space-y-1.5">
                  <div className="rounded-lg px-2 py-1.5 text-[10px]" style={{ background: 'var(--surface-soft)', color: 'var(--muted)' }}>
                    Interview Workspace
                  </div>
                  <div className="rounded-lg px-2 py-1.5 text-[10px]" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                    + Private AI Assistant
                  </div>
                </div>
              </div>

              <div
                className="rounded-xl p-3"
                style={{
                  border: protectionEnabled
                    ? '1px solid rgba(34, 197, 94, 0.2)'
                    : '1px solid rgba(245, 158, 11, 0.3)',
                  background: protectionEnabled
                    ? 'rgba(34, 197, 94, 0.04)'
                    : 'rgba(245, 158, 11, 0.06)',
                }}
              >
                <div
                  className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: protectionEnabled ? 'var(--success)' : 'var(--warning)' }}
                >
                  <EyeOff className="h-3 w-3" />
                  Interviewer Sees
                </div>
                <div className="space-y-1.5">
                  <div className="rounded-lg px-2 py-1.5 text-[10px]" style={{ background: 'var(--surface-soft)', color: 'var(--muted)' }}>
                    Interview Workspace
                  </div>
                  {protectionEnabled ? (
                    <div className="rounded-lg px-2 py-1.5 text-[10px] italic" style={{ background: 'var(--surface-soft)', color: 'var(--muted)', opacity: 0.6 }}>
                      AI Assistant absent
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[10px]" style={{ background: 'rgba(245, 158, 11, 0.15)', color: 'var(--warning)' }}>
                      <AlertTriangle className="h-2.5 w-2.5" />
                      AI Assistant VISIBLE
                    </div>
                  )}
                </div>
              </div>
            </div>

            <p className="mt-2 text-center text-[9px] leading-relaxed" style={{ color: 'var(--muted)' }}>
              Illustrative preview — verify with a real test share (e.g. Google Meet &rarr; Present &rarr; Entire screen).
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
