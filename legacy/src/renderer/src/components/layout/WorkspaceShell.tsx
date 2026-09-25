import { PropsWithChildren } from 'react';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

export function WorkspaceShell({ children }: PropsWithChildren) {
  return (
    <div className="flex h-screen w-full" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
