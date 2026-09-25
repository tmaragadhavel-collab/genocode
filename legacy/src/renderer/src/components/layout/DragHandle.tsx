import { Grip } from 'lucide-react';
import { useAssistantStore } from '../../stores/interviewStore';

export function DragHandle() {
  const protectionEnabled = useAssistantStore((s) => s.protectionEnabled);

  return (
    <div
      className="flex h-[48px] items-center justify-between px-4"
      style={{
        WebkitAppRegion: 'drag' as unknown as string,
        borderBottom: '1px solid var(--border)',
        background: 'var(--panel-strong)',
        color: 'var(--text)',
      } as React.CSSProperties}
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Grip className="h-4 w-4" style={{ color: 'var(--muted)' }} />
        <span style={{ color: 'var(--muted)' }}>Private</span>
      </div>
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <span
          className="rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.15em]"
          style={{
            background: protectionEnabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(245, 158, 11, 0.15)',
            color: protectionEnabled ? 'var(--success)' : 'var(--warning)',
          }}
        >
          {protectionEnabled ? 'Protected' : 'Visible'}
        </span>
      </div>
    </div>
  );
}
