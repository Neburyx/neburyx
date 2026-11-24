import type { ReactNode } from 'react';
import { Outlet } from 'react-router';
import { usePageKeyHandler } from '../workspace/key-binding-handler.js';
import { Sidebar } from './sidebar.js';

/** `bare` leaves the main area without the content padding, for a page that lays out its own full-height surface. */
export function PageFrame({ children, bare = false }: { readonly children: ReactNode; readonly bare?: boolean }) {
  usePageKeyHandler();
  return (
    <div className="page-shell">
      <Sidebar />
      <main className={bare ? 'page-bare' : undefined}>{children}</main>
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
