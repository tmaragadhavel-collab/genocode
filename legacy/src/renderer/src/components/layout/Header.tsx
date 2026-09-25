import { Bell, Settings2, Wifi, WifiOff, Sun, Moon } from 'lucide-react';
import { useAssistantStore, useInterviewStore } from '../../stores/interviewStore';

export function Header() {
  const { theme, setTheme } = useAssistantStore();
  const connectionMode = useInterviewStore((s) => s.connectionMode);

  const connectionConfig = {
    connected: { label: 'Connected', color: 'var(--success)', Icon: Wifi },
    demo: { label: 'Demo Mode', color: 'var(--warning)', Icon: Wifi },
    offline: { label: 'Server Offline', color: 'var(--muted)', Icon: WifiOff },
  }[connectionMode];

  const handleThemeToggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (window.appBridge) {
      window.appBridge.setTheme(next);
    }
  };

  return (
    <header
      className="flex items-center justify-between border-b px-6 py-4"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <div>
        <div className="flex items-center gap-3 text-sm" style={{ color: 'var(--muted)' }}>
          <span className="font-medium" style={{ color: 'var(--text)' }}>Technical Interview</span>
          <span className="flex items-center gap-2" style={{ color: 'var(--success)' }}>
            <span className="dot pulse" />
            Live Session
          </span>
        </div>
        <div className="mt-1 text-xs" style={{ color: 'var(--muted)' }}>AI Engineer</div>
        <div className="mt-0.5 text-[10px] uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
          Technical Round
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div
          className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs"
          style={{
            background: connectionMode === 'connected' ? 'rgba(34, 197, 94, 0.1)' : connectionMode === 'demo' ? 'rgba(234, 179, 8, 0.1)' : 'rgba(100, 116, 139, 0.1)',
            border: `1px solid ${connectionMode === 'connected' ? 'rgba(34, 197, 94, 0.3)' : connectionMode === 'demo' ? 'rgba(234, 179, 8, 0.3)' : 'rgba(100, 116, 139, 0.3)'}`,
            color: connectionConfig.color,
          }}
        >
          <connectionConfig.Icon className="h-3.5 w-3.5" />
          {connectionConfig.label}
        </div>
        <button
          onClick={handleThemeToggle}
          className="rounded-xl p-2 transition hover:opacity-80"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)', color: 'var(--muted)' }}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>
        <button
          className="rounded-xl p-2 transition hover:opacity-80"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)', color: 'var(--muted)' }}
        >
          <Bell className="h-4 w-4" />
        </button>
        <div
          className="flex h-10 w-10 items-center justify-center rounded-full text-sm font-semibold"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          AM
        </div>
        <button
          className="rounded-xl p-2 transition hover:opacity-80"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)', color: 'var(--muted)' }}
        >
          <Settings2 className="h-4 w-4" />
        </button>
      </div>
    </header>
  );
}
