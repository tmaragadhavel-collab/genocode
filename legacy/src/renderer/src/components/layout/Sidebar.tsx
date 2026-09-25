import { ChevronLeft, ChevronRight, BookOpen, Briefcase, FileText, History, HelpCircle, LayoutGrid, MessageSquareText, Settings, UserRound, Video } from 'lucide-react';
import { motion } from 'framer-motion';
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';

const navItems = [
  { label: 'Dashboard', icon: LayoutGrid, path: '/workspace' },
  { label: 'Interview Room', icon: Video, path: '/room' },
  { label: 'Interviews', icon: Briefcase, path: '/workspace' },
  { label: 'Practice', icon: MessageSquareText, path: '/workspace' },
  { label: 'History', icon: History, path: '/history' },
  { label: 'Resources', icon: BookOpen, path: '/workspace' },
];

export function Sidebar() {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <motion.aside
      animate={{ width: collapsed ? 88 : 260 }}
      transition={{ type: 'spring', stiffness: 220, damping: 24 }}
      className="panel flex h-full flex-col overflow-hidden"
      style={{ borderRight: '1px solid var(--border)', background: 'var(--panel-strong)' }}
    >
      <div className="flex items-center justify-between px-4 py-5" style={{ borderBottom: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3 overflow-hidden">
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            <Briefcase className="h-4 w-4" />
          </div>
          {!collapsed && (
            <div className="text-base font-semibold" style={{ color: 'var(--text)' }}>
              InterviewAI
            </div>
          )}
        </div>
        <button
          className="rounded-lg p-2 transition hover:opacity-80"
          onClick={() => setCollapsed((v) => !v)}
          aria-label="Toggle sidebar"
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          style={{ color: 'var(--muted)' }}
        >
          {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      <div className="space-y-1 px-3 py-4">
        <div className="px-2 pb-2 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
          {!collapsed ? 'Navigation' : ''}
        </div>
        {navItems.map(({ label, icon: Icon, path }) => {
          const isActive = location.pathname === path;
          return (
            <button
              key={label}
              onClick={() => navigate(path)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition hover:opacity-90"
              title={collapsed ? label : undefined}
              style={{
                color: isActive ? 'var(--text)' : 'var(--muted)',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
              }}
              onMouseEnter={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'var(--accent-soft)';
                  e.currentTarget.style.color = 'var(--text)';
                }
              }}
              onMouseLeave={(e) => {
                if (!isActive) {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.color = 'var(--muted)';
                }
              }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{label}</span>}
            </button>
          );
        })}
      </div>

      <div className="mt-auto space-y-2 px-3 py-4" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="space-y-1">
          {!collapsed && (
            <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.2em]" style={{ color: 'var(--muted)' }}>
              Workspace
            </div>
          )}
          <div
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm"
            style={{ background: 'var(--accent-soft)', color: 'var(--text)' }}
          >
            <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--success)' }} />
            {!collapsed && <span>Current Interview</span>}
          </div>
          <div
            className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm"
            style={{ background: 'var(--surface-soft)', color: 'var(--text)' }}
          >
            <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: 'var(--accent)' }} />
            {!collapsed && <span>Transcript</span>}
          </div>
        </div>

        <div className="space-y-1 pt-2">
          {[
            { label: 'Help & Support', icon: HelpCircle },
            { label: 'Settings', icon: Settings },
            { label: 'Candidate Profile', icon: UserRound },
          ].map(({ label, icon: Icon }) => (
            <button
              key={label}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm transition hover:opacity-90"
              title={collapsed ? label : undefined}
              style={{ color: 'var(--muted)' }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && <span>{label}</span>}
            </button>
          ))}
        </div>

        <div
          className="mt-4 flex items-center gap-3 rounded-2xl p-3"
          style={{ border: '1px solid var(--border)', background: 'var(--surface-soft)' }}
        >
          <div
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold"
            style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
          >
            AM
          </div>
          {!collapsed && (
            <div>
              <div className="text-sm font-semibold" style={{ color: 'var(--text)' }}>Alex Morgan</div>
              <div className="text-xs" style={{ color: 'var(--muted)' }}>AI Engineer</div>
            </div>
          )}
        </div>
      </div>
    </motion.aside>
  );
}
