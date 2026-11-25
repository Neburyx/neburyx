import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBroadcastChannel } from '../windows/fake-broadcast.js';
import { forgetOpenedWindows } from '../windows/pop-out.js';
import { createWindowChannel } from '../windows/window-channel.js';
import { harness } from './assistant-kit.js';
import { ASSISTANT_COPY } from './copy.js';

const SCOPE = { principalId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', investigationId: 'inv-1', sourceId: 'a' };
let restore: () => void = () => undefined;
const fakeWindow = (href = '/assistant/inv-1') => ({ closed: false, focus: vi.fn(), close: vi.fn(), location: { href } });

beforeEach(() => {
  restore = installFakeBroadcastChannel();
});
afterEach(() => {
  cleanup();
  forgetOpenedWindows();
  vi.restoreAllMocks();
  restore();
});

const panel = async () => {
  const h = harness(async () => ({ ok: true, value: { status: 'refused', cause: 'verdict', sentence: 's' } as never }));
  render(h.tree());
  await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
  return h;
};

describe('the Pop out button of the panel header', () => {
  it('is a button named Pop out before Close', async () => {
    await panel();
    const names = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent ?? '').filter((name) => ['Pop out', 'Close'].includes(name));
    expect(names).toEqual(['Pop out', 'Close']);
  });

  it('shows the title and the sentence of the frame on hover and on keyboard focus, and hides them when the pointer or the focus leaves', async () => {
    await panel();
    const button = screen.getByRole('button', { name: 'Pop out' });
    await userEvent.hover(button);
    expect(screen.getByRole('tooltip').textContent).toBe(`${ASSISTANT_COPY.popOut}${ASSISTANT_COPY.popOutTip}`);
    expect(button.getAttribute('aria-describedby')).toBe(screen.getByRole('tooltip').id);
    await userEvent.unhover(button);
    expect(screen.queryByRole('tooltip')).toBeNull();
    await userEvent.tab({ shift: true });
    button.focus();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens the page of the investigation in a window of its own, and says nothing when it opens', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(fakeWindow() as unknown as Window);
    await panel();
    await userEvent.click(screen.getByRole('button', { name: 'Pop out' }));
    expect(open).toHaveBeenCalledWith('/assistant/inv-1', 'neburyx-assistant-inv-1');
    expect(screen.queryByText(ASSISTANT_COPY.popOutRefused)).toBeNull();
  });

  it('says once, beside the header, that the window could not be opened when the browser refuses it, leaves the panel as it was, and tries again on the next press', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValueOnce(null).mockReturnValueOnce(fakeWindow() as unknown as Window);
    await panel();
    const button = screen.getByRole('button', { name: 'Pop out' });
    await userEvent.click(button);
    expect(screen.getAllByText(ASSISTANT_COPY.popOutRefused)).toHaveLength(1);
    expect(screen.getByLabelText(ASSISTANT_COPY.fieldLabel)).toBeTruthy();
    await userEvent.click(button);
    expect(open).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(ASSISTANT_COPY.popOutRefused)).toBeNull();
  });

  it('focuses the window it opened on a second press, and opens nothing and reloads nothing', async () => {
    const page = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(page as unknown as Window);
    await panel();
    await userEvent.click(screen.getByRole('button', { name: 'Pop out' }));
    await userEvent.click(screen.getByRole('button', { name: 'Pop out' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(page.focus).toHaveBeenCalledTimes(1);
  });

  it('is pressed while a page of this investigation is open in another window, and finds that window by its name, with no address, on a press', async () => {
    const page = fakeWindow();
    const open = vi.spyOn(window, 'open').mockReturnValue(page as unknown as Window);
    await panel();
    const button = screen.getByRole('button', { name: 'Pop out' });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    const other = createWindowChannel(SCOPE);
    let stop: () => void = () => undefined;
    await act(async () => {
      stop = other.announce('assistant');
    });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(button);
    expect(open).toHaveBeenCalledWith('', 'neburyx-assistant-inv-1');
    expect(page.focus).toHaveBeenCalledTimes(1);
    await act(async () => stop());
    expect(button.getAttribute('aria-pressed')).toBe('false');
    other.close();
  });

  it('is not pressed by a page of another investigation or another source', async () => {
    await panel();
    const button = screen.getByRole('button', { name: 'Pop out' });
    const others = [createWindowChannel({ ...SCOPE, investigationId: 'inv-2' }), createWindowChannel({ ...SCOPE, sourceId: 'b' })];
    await act(async () => {
      for (const other of others) other.announce('assistant');
    });
    expect(button.getAttribute('aria-pressed')).toBe('false');
    for (const other of others) other.close();
  });
});
