import { CanvasRegions } from './canvas-regions.js';
import { GraphScope } from './graph-scope.js';
import { HeaderBar } from './header-bar.js';
import { NavigationRail } from './navigation-rail.js';
import { NoticeStrip } from './notice-strip.js';

export function WorkspaceShell() {
  return (
    <div className="workspace">
      <NavigationRail />
      <div className="workspace-body">
        <HeaderBar />
        <NoticeStrip />
        <main className="canvas-region">
          <GraphScope />
          <CanvasRegions />
        </main>
      </div>
    </div>
  );
}
