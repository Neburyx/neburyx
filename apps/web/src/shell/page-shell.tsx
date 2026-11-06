import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { usePageKeyHandler } from '../workspace/key-binding-handler.js';
import { Sidebar } from './sidebar.js';

export function PageFrame({ children }: { readonly children: ReactNode }) {
  usePageKeyHandler();
  return (
    <div className="page-shell">
      <Sidebar />
      <main>{children}</main>
    </div>
  );
}

export function PageShell() {
  return (
    <PageFrame>
      <Outlet />
    </PageFrame>
  );
}
