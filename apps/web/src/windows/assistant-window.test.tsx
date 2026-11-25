import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from '../assistant/assistant-kit.js';
import { ClientStateProvider } from '../state/context.js';
import { ApiClientProvider } from '../api/client-context.js';
import { ShellDataProvider } from '../shell/shell-data.js';
import { useAssistantPageWindow } from './assistant-window.js';
import { installFakeBroadcastChannel } from './fake-broadcast.js';
import { createWindowChannel, type WindowChannel } from './window-channel.js';

const PRINCIPAL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
let restore: () => void = () => undefined;
let watchers: WindowChannel[] = [];

beforeEach(() => {
  restore = installFakeBroadcastChannel();
  window.name = '';
});
afterEach(() => {
  cleanup();
  for (const watcher of watchers) watcher.close();
  watchers = [];
  window.name = '';
  restore();
});

function Page() {
  useAssistantPageWindow();
  return null;
}

const mount = () => {
  const h = harness(async () => ({ ok: true, value: { status: 'refused', cause: 'verdict', sentence: 's' } as never }));
  const view = render(
    <ApiClientProvider client={h.client}>
      <ClientStateProvider state={h.state}>
        <ShellDataProvider store={h.shell}>
          <Page />
        </ShellDataProvider>
      </ClientStateProvider>
    </ApiClientProvider>,
  );
  return { h, view };
};
const watcher = (investigationId: string, sourceId = 'a'): WindowChannel => {
  const channel = createWindowChannel({ principalId: PRINCIPAL, investigationId, sourceId });
  watchers.push(channel);
  return channel;
};

describe('the window that shows the Assistant page', () => {
  it('tells the other windows of the investigation and source that a page is open, and nothing of any other investigation, until it is left', async () => {
    const same = watcher('inv-1');
    const otherInvestigation = watcher('inv-2');
    const otherSource = watcher('inv-1', 'b');
    const { view } = mount();
    await act(async () => undefined);
    expect([...same.others.getState()]).toEqual(['assistant']);
    expect(otherInvestigation.others.getState().size).toBe(0);
    expect(otherSource.others.getState().size).toBe(0);
    view.unmount();
    expect(same.others.getState().size).toBe(0);
  });

  it('takes the name by which Pop out finds it when it has none, and gives it up when the page is left', async () => {
    const { view } = mount();
    await act(async () => undefined);
    expect(window.name).toBe('neburyx-assistant-inv-1');
    view.unmount();
    expect(window.name).toBe('');
  });

  it('keeps a name the window already has', async () => {
    window.name = 'another';
    const { view } = mount();
    await act(async () => undefined);
    expect(window.name).toBe('another');
    view.unmount();
    expect(window.name).toBe('another');
  });
});
