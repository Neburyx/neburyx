import { GraphCanvas } from '../canvas/graph-canvas.js';
import { useProfile } from '../canvas/profile-context.js';
import { CanvasRegions } from './canvas-regions.js';
import { GraphScope } from './graph-scope.js';
import { HeaderBar } from './header-bar.js';
import { NavigationRail } from './navigation-rail.js';
import { NoticeStrip } from './notice-strip.js';
import { SelectionBar } from './selection-bar.js';

export function WorkspaceShell({ canvasView }: { readonly canvasView?: 'fit' | 'as-drawn' }) {
  const profile = useProfile();
  return (
    <div className="workspace">
      <NavigationRail />
      <div className="workspace-body">
        <HeaderBar />
        <NoticeStrip />
        <main className="canvas-region">
          <GraphCanvas profile={profile} view={canvasView} />
          <GraphScope />
          <SelectionBar />
          <CanvasRegions />
        </main>
      </div>
    </div>
  );
}
