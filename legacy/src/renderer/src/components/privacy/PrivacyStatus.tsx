import { ShieldCheck, ShieldOff, Monitor, Eye, EyeOff } from 'lucide-react';
import { useAssistantStore } from '../../stores/interviewStore';
import { motion } from 'framer-motion';

export function PrivacyStatus() {
  const { protectionEnabled, setProtection } = useAssistantStore();

  const handleToggle = () => {
    const next = !protectionEnabled;
    setProtection(next);
    if (window.appBridge) {
      window.appBridge.setProtection(next);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay: 0.3 }}
      className="rounded-2xl p-4"
      style={{
        border: protectionEnabled
          ? '1px solid rgba(34, 197, 94, 0.2)'
          : '1px solid rgba(245, 158, 11, 0.3)',
        background: protectionEnabled
          ? 'rgba(34, 197, 94, 0.06)'
          : 'rgba(245, 158, 11, 0.08)',
      }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {protectionEnabled ? (
            <ShieldCheck className="h-4 w-4" style={{ color: 'var(--success)' }} />
          ) : (
            <ShieldOff className="h-4 w-4" style={{ color: 'var(--warning)' }} />
          )}
          <span className="text-xs font-bold uppercase tracking-[0.15em]" style={{ color: 'var(--text)' }}>
            Private Assistance
          </span>
        </div>
        <span
          className="rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.15em]"
          style={{
            background: protectionEnabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)',
            color: protectionEnabled ? 'var(--success)' : 'var(--warning)',
          }}
        >
          {protectionEnabled ? 'Protected' : 'Visible'}
        </span>
      </div>

      <p className="mb-3 text-xs leading-relaxed" style={{ color: 'var(--muted)' }}>
        {protectionEnabled
          ? 'This assistant window is excluded from screen capture by the operating system. Verify with a test share before your interview.'
          : 'Content protection is OFF — this window is visible in screen shares.'}
      </p>

      <div className="mb-3 space-y-2 rounded-xl p-3" style={{ border: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
            {protectionEnabled ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
            Screen Share
          </div>
          <span className="font-semibold" style={{ color: 'var(--text)' }}>
            {protectionEnabled ? 'Interview workspace only' : 'All windows visible'}
          </span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <div className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
            <Monitor className="h-3 w-3" />
            Assistant
          </div>
          <span className="font-semibold" style={{ color: 'var(--text)' }}>
            {protectionEnabled ? 'Excluded from capture' : 'Included in capture'}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={handleToggle}
          className="relative inline-flex h-6 w-11 items-center rounded-full transition-colors"
          style={{ background: protectionEnabled ? 'var(--success)' : 'var(--muted)' }}
          role="switch"
          aria-checked={protectionEnabled}
          aria-label="Toggle content protection"
        >
          <span
            className="inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition-transform"
            style={{ transform: protectionEnabled ? 'translateX(22px)' : 'translateX(4px)' }}
          />
        </button>
        <span className="text-[10px]" style={{ color: 'var(--muted)' }}>
          Ctrl+Shift+P
        </span>
      </div>

      {!protectionEnabled && (
        <div
          className="mt-2 rounded-lg px-3 py-2 text-[10px]"
          style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--warning)' }}
        >
          Warning: Protection is off. Your assistant window may be visible when sharing your screen.
        </div>
      )}
    </motion.div>
  );
}
