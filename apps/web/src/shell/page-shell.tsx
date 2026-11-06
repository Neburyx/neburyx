import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { Sidebar } from './sidebar.js';

export function PageFrame({ children }: { readonly children: ReactNode }) {
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
