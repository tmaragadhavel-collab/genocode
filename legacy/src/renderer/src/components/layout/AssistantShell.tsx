import { PropsWithChildren } from 'react';
import { ShieldCheck, Minus } from 'lucide-react';
import { DragHandle } from './DragHandle';
import { useAssistantStore } from '../../stores/interviewStore';

export function AssistantShell({ children }: PropsWithChildren) {
  const state = useAssistantStore((s) => s.state);

  const handleMinimize = () => {
    if (window.appBridge) {
      window.appBridge.toggleAssistant(false);
    }
  };

  const stateColor = (() => {
    switch (state) {
      case 'Suggestion ready': return 'var(--success)';
      case 'Paused': return 'var(--warning)';
      default: return 'var(--accent)';
    }
  })();

  return (
    <div
      className="h-screen w-full overflow-hidden rounded-[24px]"
      style={{
        background: 'var(--panel-strong)',
        border: '1px solid var(--border)',
        color: 'var(--text)',
        boxShadow: '0 25px 60px rgba(0,0,0,0.3)',
      }}
    >
      <DragHandle />
      <div className="flex h-[calc(100%-48px)] flex-col overflow-hidden">
        <div className="px-4 py-3" style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface-soft)' }}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--accent)' }} />
              AI Interview Copilot
            </div>
            <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <button
                onClick={handleMinimize}
                className="rounded-lg p-1.5 transition hover:opacity-80"
                style={{ border: '1px solid var(--border)', color: 'var(--muted)' }}
                aria-label="Hide assistant (Ctrl+Shift+H)"
                title="Hide assistant (Ctrl+Shift+H)"
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: stateColor }} />
            {state}...
          </div>
        </div>
        <div className="flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
