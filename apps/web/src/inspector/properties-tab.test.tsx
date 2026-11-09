import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COPY_ANSWER_MS } from '../workspace/copy-button.js';
import { entity, inInspector, inspectorRig, property, select } from './inspector-kit.js';

const written: string[] = [];

function user(refuse = false) {
  const session = userEvent.setup();
  written.length = 0;
  vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text: string) => (refuse ? Promise.reject(new Error('denied')) : void written.push(text)));
  return session;
}

async function open(properties = [property('holder', 'Jordan'), property('opened', '2024-02-06T09:00:00Z', 'dateTime'), property('note', undefined), property('phone', '+1 ••• ••• ••42', 'phone', true)]) {
  const rig = inspectorRig({ nodes: [entity('n1', properties)] });
  select(rig.state, 'n1');
  fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
  return rig;
}
const answer = (role: 'status' | 'alert'): string => [...document.querySelectorAll(`.inspector-properties .copy-answer[role="${role}"]`)].map((region) => region.textContent).join('');
const lines = (): string[] => [...document.querySelectorAll('.inspector-properties .inspector-row')].map((row) => row.querySelector('dt')?.textContent + '|' + row.querySelector('dd')?.textContent);


describe('the Properties tab', () => {
  it('lists every property of the node in order, "unavailable" for a missing value, the mask for a masked one, and draws no mask switch', async () => {
    await open();
    expect(lines()).toEqual(['holder|Jordan', 'opened|6 Feb 2024, 09:00:00 UTC', 'note|unavailable', 'phone|+1 ••• ••• ••42']);
    expect(screen.queryByRole('switch')).toBeNull();
    expect(inInspector().queryByText(/Mask sensitive/)).toBeNull();
  });

  it('copies exactly the shown text of one property and says "Copied"', async () => {
    const session = user();
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy opened' }));
    expect(written).toEqual(['6 Feb 2024, 09:00:00 UTC']);
    await waitFor(() => expect(answer('status')).toBe('Copied'));
  });

  it('copies a masked property as its mask and a missing one as "unavailable"', async () => {
    const session = user();
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy phone' }));
    await session.click(screen.getByRole('button', { name: 'Copy note' }));
    expect(written).toEqual(['+1 ••• ••• ••42', 'unavailable']);
  });

  it('copies all as one line per property, name and shown text, in the order shown', async () => {
    const session = user();
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy all properties' }));
    expect(written).toEqual(['holder: Jordan\nopened: 6 Feb 2024, 09:00:00 UTC\nnote: unavailable\nphone: +1 ••• ••• ••42']);
    await waitFor(() => expect(answer('status')).toBe('Copied'));
  });

  it('says "Could not copy" in an alert when the clipboard refuses, and changes nothing else', async () => {
    const session = user(true);
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy all properties' }));
    await waitFor(() => expect(answer('alert')).toBe('Could not copy'));
    expect(lines()).toHaveLength(4);
  });

  it('says "Could not copy" when the browser has no clipboard', async () => {
    const session = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy all properties' }));
    await waitFor(() => expect(answer('alert')).toBe('Could not copy'));
  });

  it('reaches every Copy button in order with the keyboard and runs one with Enter and Space', async () => {
    const session = user();
    await open();
    const buttons = [...document.querySelectorAll('.inspector-properties button')];
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual(['Copy all properties', 'Copy holder', 'Copy opened', 'Copy note', 'Copy phone']);
    expect(buttons.map((button) => button.textContent)).toEqual(['Copy all', '', '', '', '']);
    (buttons[1] as HTMLElement).focus();
    await session.keyboard('{Enter}');
    await session.keyboard(' ');
    expect(written).toEqual(['Jordan', 'Jordan']);
  });

  it('draws a row button as the copy icon alone and Copy all as the icon with its words', async () => {
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    expect(row.querySelector('.icon-copy')).not.toBeNull();
    expect(row.textContent).toBe('');
    const all = screen.getByRole('button', { name: 'Copy all properties' });
    expect(all.querySelector('.icon-copy')).not.toBeNull();
    expect(all.textContent).toBe('Copy all');
  });

  it('shows the tooltip on focus and on hover, says Copied in it and swaps the icon, keeping the focus on the button', async () => {
    const session = user();
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    const tip = (): Element | null => row.parentElement?.querySelector('.copy-tip') ?? null;
    expect(tip()?.hasAttribute('data-shown')).toBe(false);
    await session.hover(row);
    expect(tip()?.textContent).toBe('Copy holder');
    expect(tip()?.hasAttribute('data-shown')).toBe(true);
    await session.unhover(row);
    expect(tip()?.hasAttribute('data-shown')).toBe(false);
    act(() => row.focus());
    expect(tip()?.hasAttribute('data-shown')).toBe(true);
    await session.keyboard('{Enter}');
    await waitFor(() => expect(answer('status')).toBe('Copied'));
    expect(tip()?.textContent).toBe('Copied');
    expect(row.querySelector('.icon-check')).not.toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it('hides the tooltip on Esc without closing the inspector, and Esc with no tooltip still closes it', async () => {
    const session = user();
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    act(() => row.focus());
    await session.keyboard('{Escape}');
    expect(row.parentElement?.querySelector('.copy-tip')?.hasAttribute('data-shown')).toBe(false);
    expect(screen.queryByRole('tab', { name: 'Properties' })).not.toBeNull();
    await session.keyboard('{Escape}');
    expect(screen.queryByRole('tab', { name: 'Properties' })).toBeNull();
  });

  it('says Could not copy in the tooltip when the clipboard refuses', async () => {
    const session = user(true);
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    await session.click(row);
    await waitFor(() => expect(answer('alert')).toBe('Could not copy'));
    expect(row.parentElement?.querySelector('.copy-tip')?.textContent).toBe('Could not copy');
  });

  it('hides the tooltip on Esc while only hovering, with the focus elsewhere, and the inspector stays open', async () => {
    const session = user();
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    await session.hover(row);
    expect(row.parentElement?.querySelector('.copy-tip')?.hasAttribute('data-shown')).toBe(true);
    await session.keyboard('{Escape}');
    expect(row.parentElement?.querySelector('.copy-tip')?.hasAttribute('data-shown')).toBe(false);
    expect(screen.queryByRole('tab', { name: 'Properties' })).not.toBeNull();
  });

  it('is the copy icon with its own name again once the answer has been shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const session = user();
      await open();
      const row = screen.getByRole('button', { name: 'Copy holder' });
      await session.click(row);
      await waitFor(() => expect(row.querySelector('.icon-check')).not.toBeNull());
      act(() => void vi.advanceTimersByTime(COPY_ANSWER_MS));
      expect(row.querySelector('.icon-copy')).not.toBeNull();
      expect(answer('status')).toBe('');
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces Copied again on a second copy', async () => {
    const session = user();
    await open();
    const row = screen.getByRole('button', { name: 'Copy holder' });
    await session.click(row);
    await waitFor(() => expect(answer('status')).toBe('Copied'));
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(answer('status')));
    watch.observe(document.querySelector('.inspector-properties') as Node, { subtree: true, childList: true, characterData: true });
    await session.click(row);
    await waitFor(() => expect(answer('status')).toBe('Copied'));
    watch.disconnect();
    expect(seen).toContain('');
  });
});
