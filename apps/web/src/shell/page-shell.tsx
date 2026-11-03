import { Outlet } from 'react-router';
import { Sidebar } from './sidebar.js';

export function PageShell() {
  return (
    <div className="page-shell">
      <Sidebar />
      <main>
        <Outlet />
      </main>
    </div>
  );
}
