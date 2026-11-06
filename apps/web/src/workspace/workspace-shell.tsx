import type { ReactNode } from 'react';
import { GraphCanvas } from '../canvas/graph-canvas.js';
import { useProfile } from '../canvas/profile-context.js';
import { CanvasRegions } from './canvas-regions.js';
import { ContextMenu } from './context-menu.js';
import { DockColumn, FloatingPanels } from './panel-host.js';
import { GraphScope } from './graph-scope.js';
import { HeaderBar } from './header-bar.js';
import { KEY_SCOPE_ATTRIBUTE, useKeyHandler } from './key-binding-handler.js';
import { NavigationRail } from './navigation-rail.js';
import { NoticeStrip } from './notice-strip.js';
import { useWorkspaceMark } from './workspace-presence.js';
import { ShortcutSheet } from './shortcut-sheet.js';
import { SelectionBar } from './selection-bar.js';

export function WorkspaceShell({ canvasView, notice, status, busy = false }: { readonly canvasView?: 'fit' | 'as-drawn'; readonly notice?: ReactNode; readonly status?: ReactNode; readonly busy?: boolean }) {
  const profile = useProfile();
  useKeyHandler();
  useWorkspaceMark();
  return (
    <div className="workspace" {...{ [KEY_SCOPE_ATTRIBUTE]: 'workspace' }}>
      <NavigationRail />
      <div className="workspace-body">
        <HeaderBar />
        <NoticeStrip extra={notice} />
        {status === undefined ? null : <div className="status-strip">{status}</div>}
        <div className="workspace-stage">
          <main className="canvas-region" aria-busy={busy ? true : undefined}>
            <GraphCanvas profile={profile} view={canvasView} />
            <GraphScope />
            <SelectionBar />
            <ContextMenu />
            <CanvasRegions />
            <FloatingPanels />
          </main>
          <DockColumn />
        </div>
      </div>
      <ShortcutSheet />
    </div>
  );
}
