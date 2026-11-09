import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
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
    expect(await screen.findByText('Copied')).toBeTruthy();
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
    await session.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(written).toEqual(['holder: Jordan\nopened: 6 Feb 2024, 09:00:00 UTC\nnote: unavailable\nphone: +1 ••• ••• ••42']);
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('says "Could not copy" in an alert when the clipboard refuses, and changes nothing else', async () => {
    const session = user(true);
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy all' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not copy');
    expect(lines()).toHaveLength(4);
  });

  it('says "Could not copy" when the browser has no clipboard', async () => {
    const session = userEvent.setup();
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await open();
    await session.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
  });

  it('reaches every Copy button in order with the keyboard and runs one with Enter and Space', async () => {
    const session = user();
    await open();
    const buttons = [...document.querySelectorAll('.inspector-properties button')];
    expect(buttons.map((button) => button.textContent)).toEqual(['Copy all', 'Copy', 'Copy', 'Copy', 'Copy']);
    (buttons[1] as HTMLElement).focus();
    await session.keyboard('{Enter}');
    await session.keyboard(' ');
    expect(written).toEqual(['Jordan', 'Jordan']);
  });
});
