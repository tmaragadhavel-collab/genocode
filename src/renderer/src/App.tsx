import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { WorkspacePage } from './pages/WorkspacePage';
import { AssistantPage } from './pages/AssistantPage';
import { useAssistantStore } from './stores/interviewStore';

export default function App() {
  const theme = useAssistantStore((s) => s.theme);
  const setTheme = useAssistantStore((s) => s.setTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  useEffect(() => {
    if (!window.appBridge) return;

    const listener = window.appBridge.on('THEME_CHANGED', (...args: unknown[]) => {
      const payload = args[0] as { theme: 'light' | 'dark' } | undefined;
      if (payload?.theme) {
        setTheme(payload.theme);
      }
    });

    return () => {
      window.appBridge.off('THEME_CHANGED', listener);
    };
  }, [setTheme]);

  return (
    <Routes>
      <Route path="/workspace" element={<WorkspacePage />} />
      <Route path="/assistant" element={<AssistantPage />} />
      <Route path="*" element={<Navigate to="/workspace" replace />} />
    </Routes>
  );
}
