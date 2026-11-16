import { render } from '@testing-library/react';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { CanvasCommandsProvider, useCanvasCommandsHandle } from '../canvas/canvas-commands.js';
import type { CanvasRenderer } from '../canvas/scene.js';
import type { SnapshotBounds } from '../canvas/snapshot.js';
import { stubFactory } from '../test-utils.js';
import { fakeClient } from '../api/fake-client.js';
import { BannerProvider } from '../banner/banner-context.js';
import { createBannerController } from '../banner/banner-controller.js';
import { StatusBanner } from '../banner/status-banner.js';
import { shownState } from '../lifecycle/harness.js';
import type { ClientState } from '../state/client-state.js';
import { ShellDataProvider, type ShellData } from '../shell/shell-data.js';
import { ClientStateProvider } from '../state/context.js';
import type { ReadableStore } from '../state/store.js';
import { createSlotRegistry, Slot, SlotsProvider } from '../workspace/slots.js';
import { registerExport } from './register-export.js';

export { shownState };

function ShellOrNot({ shell, children }: { readonly shell: ReadableStore<ShellData> | undefined; readonly children: ReactNode }) {
  return shell === undefined ? <>{children}</> : <ShellDataProvider store={shell}>{children}</ShellDataProvider>;
}

export type Snapshot = (bounds: SnapshotBounds) => Promise<Blob>;

/** Makes the canvas commands of a renderer that takes the given picture, as the workspace does. */
function AttachCanvas({ snapshot }: { readonly snapshot: Snapshot }) {
  const handle = useCanvasCommandsHandle();
  useEffect(() => {
    const renderer: CanvasRenderer = Object.assign(stubFactory().create(), { snapshot });
    return handle.attach(renderer, () => undefined, () => undefined);
  }, [handle, snapshot]);
  return null;
}

const PICTURE = (): Promise<Blob> => Promise.resolve(new Blob(['drawing'], { type: 'image/png' }));

/** The header with its Export slot and the banner, over a fake client; the canvas takes `snapshot` as its picture. */
export function renderExport(state: ClientState, overrides: Partial<ApiClient> = {}, snapshot: Snapshot = PICTURE, shell?: ReadableStore<ShellData>) {
  const banner = createBannerController();
  const slots = createSlotRegistry();
  const client = fakeClient(overrides);
  registerExport(slots, client);
  render(
    <MemoryRouter>
      <ShellOrNot shell={shell}>
      <ClientStateProvider state={state}>
        <BannerProvider controller={banner}>
          <CanvasCommandsProvider>
          <AttachCanvas snapshot={snapshot} />
          <SlotsProvider registry={slots}>
            <Slot name="export" />
            <StatusBanner />
          </SlotsProvider>
          </CanvasCommandsProvider>
        </BannerProvider>
      </ClientStateProvider>
      </ShellOrNot>
    </MemoryRouter>,
  );
  return { state, banner, client };
}

