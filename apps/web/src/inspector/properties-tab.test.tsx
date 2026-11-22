import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { COPY_ANSWER_MS } from '../workspace/copy-button.js';
import type { ReadRefsRequest, ReadRefsResponse } from '@neburyx/contracts';
import type { ApiResult } from '../api/client.js';
import { answerEntity, entity, failure, inInspector, inspector, inspectorRig, profileOf, property, select } from './inspector-kit.js';

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
  it('lists every property of the node in order, "unavailable" for a missing value, the mask for a masked one', async () => {
    await open();
    expect(lines()).toEqual(['holder|Jordan', 'opened|6 Feb 2024, 09:00:00 UTC', 'note|unavailable', 'phone|+1 ••• ••• ••42']);
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


describe('the masking switch in the Properties tab', () => {
  interface Read {
    readonly request: ReadRefsRequest;
    readonly answer: (result: ApiResult<ReadRefsResponse>) => void;
  }

  async function openSwitch() {
    const reads: Read[] = [];
    const plain = entity('n1', [property('holder', 'Jordan Lee', 'name'), property('status', 'open')]);
    const rig = inspectorRig({ nodes: [plain], client: { readRefs: (request) => new Promise((resolve) => void reads.push({ request, answer: resolve })) } });
    select(rig.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    return { rig, reads, plain, user: userEvent.setup() };
  }
  const maskedNode = (id: string) => ({ ...entity(id, [property('holder', 'J••• L•••', 'name', true), property('status', 'open')]), display: { title: 'J••• L•••', type: 'kind-a' } });
  const answerRead = (read: Read | undefined, nodes: ReturnType<typeof maskedNode>[]) => act(async () => read?.answer({ ok: true, value: { nodes, edges: [], missing: { entities: [], edges: [] } } }));

  it('draws the switch off, named "Mask sensitive values", with its note', async () => {
    await openSwitch();
    const control = screen.getByRole('switch', { name: 'Mask sensitive values' });
    expect(control).toHaveProperty('checked', false);
    expect(inInspector().getByText(/Fields marked pii in neburyx.yaml/)).toBeTruthy();
  });

  it('turns on with Space, reads the references of the view once with the flag, then shows the masks, copies them, and keeps the inspector and the focus', async () => {
    const { reads, user } = await openSwitch();
    const control = screen.getByRole('switch', { name: 'Mask sensitive values' });
    control.focus();
    await user.keyboard(' ');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.request).toMatchObject({ mask: true, entities: [{ sourceId: 'a', entityType: 'type-a', stableId: 'n1' }], edges: [] });
    expect(inInspector().getByRole('status').textContent).toBe('Re-reading the view');
    expect(inspector()).not.toBeNull();
    await answerRead(reads[0], [maskedNode('n1')]);
    await waitFor(() => expect(lines()).toContain('holder|J••• L•••'));
    expect(inspector()).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    expect(screen.getByRole('switch', { name: 'Mask sensitive values' })).toHaveProperty('checked', true);
    const written: string[] = [];
    vi.spyOn(navigator.clipboard, 'writeText').mockImplementation(async (text: string) => void written.push(text));
    await user.click(screen.getByRole('button', { name: 'Copy all properties' }));
    expect(written).toEqual(['holder: J••• L•••\nstatus: open']);
  });

  it('turns off the same way and shows the real values again after the read', async () => {
    const { reads, user, plain } = await openSwitch();
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    await answerRead(reads[0], [maskedNode('n1')]);
    await waitFor(() => expect(lines()).toContain('holder|J••• L•••'));
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    expect(reads[1]?.request.mask).toBeUndefined();
    await act(async () => reads[1]?.answer({ ok: true, value: { nodes: [plain], edges: [], missing: { entities: [], edges: [] } } }));
    await waitFor(() => expect(lines()).toContain('holder|Jordan Lee'));
  });

  it('shows the failure with Try again and nothing of either setting while the read failed, and reads again on Try again', async () => {
    const { reads, user, rig } = await openSwitch();
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    await act(async () => reads[0]?.answer({ ok: false, failure: failure('RATE_LIMITED', true) }));
    expect(inInspector().getByText(/RATE_LIMITED/)).toBeTruthy();
    expect(lines()).toEqual([]);
    expect(rig.state.loadedGraph().nodes).toEqual([]);
    await user.click(inInspector().getByRole('button', { name: 'Try again' }));
    expect(reads).toHaveLength(2);
    expect(reads[1]?.request.mask).toBe(true);
    await answerRead(reads[1], [maskedNode('n1')]);
    await waitFor(() => expect(lines()).toContain('holder|J••• L•••'));
  });

  it('is not locked by a property masked by the request, and is locked and on, with its note, by one masked by a policy', async () => {
    const policy = { ...property('phone', '+1 ••••••45', 'phone', true), maskedBy: 'policy' as const };
    const request = { ...property('phone', '+1 ••••••45', 'phone', true), maskedBy: 'request' as const };
    const open = (properties: ReturnType<typeof property>[]) => {
      const reads: Read[] = [];
      const rig = inspectorRig({ nodes: [entity('n1', properties)], client: { readRefs: (asked) => new Promise((resolve) => void reads.push({ request: asked, answer: resolve })) } });
      select(rig.state, 'n1');
      fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
      return { rig, reads };
    };
    const first = open([request]);
    expect(screen.getByRole('switch', { name: 'Mask sensitive values' }).getAttribute('aria-disabled')).toBeNull();
    cleanup();
    const second = open([policy]);
    const locked = screen.getByRole('switch', { name: 'Mask sensitive values · Locked by policy' });
    expect(locked).toHaveProperty('checked', true);
    expect(locked.getAttribute('aria-disabled')).toBe('true');
    expect(inInspector().getByText(/Your role cannot view sensitive properties/)).toBeTruthy();
    await userEvent.setup().click(locked);
    expect(second.reads).toEqual([]);
    expect(second.rig.state.mask.getState()).toBe(false);
    expect(first.reads).toEqual([]);
  });

  it('stays locked when the read after a turn of the switch returns a property masked by a policy', async () => {
    const { reads, user } = await openSwitch();
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    const policy = { ...entity('n1', [{ ...property('holder', 'J••• L•••', 'name', true), maskedBy: 'policy' as const }]), display: { title: 'J••• L•••', type: 'kind-a' } };
    await answerRead(reads[0], [policy]);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Mask sensitive values · Locked by policy' }).getAttribute('aria-disabled')).toBe('true'));
  });

  it('says how many fields the mapping marks sensitive for the types in the view, once per type, in both states and for none, and says nothing while the read runs', async () => {
    const base = profileOf();
    const withPii = (pii: readonly string[]) => ({ ...base, entityTypes: base.entityTypes.map((entry) => ({ ...entry, pii: [...pii] })) });
    const reads: Read[] = [];
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Jordan Lee', 'name')]), entity('n2')], profile: withPii(['holder', 'phone']), client: { readRefs: (asked) => new Promise((resolve) => void reads.push({ request: asked, answer: resolve })) } });
    select(rig.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inInspector().getByText('2 sensitive fields are shown')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    expect(screen.getByRole('switch', { name: 'Mask sensitive values' })).toHaveProperty('disabled', true);
    expect(inInspector().queryByText(/sensitive fields are shown|fields masked/)).toBeNull();
    await act(async () => reads[0]?.answer({ ok: true, value: { nodes: [maskedNode('n1'), maskedNode('n2')], edges: [], missing: { entities: [], edges: [] } } }));
    await waitFor(() => expect(inInspector().getByText('2 fields masked in this view')).toBeTruthy());
    expect(screen.getByRole('switch', { name: 'Mask sensitive values' })).toHaveProperty('disabled', false);
  });

  it.each([
    [['holder'], 'off', '1 sensitive field is shown'],
    [[], 'off', '0 sensitive fields are shown'],
  ])('reads "%s" fields as "%s" in the caption', (pii, _state, caption) => {
    const base = profileOf();
    const rig = inspectorRig({ nodes: [entity('n1')], profile: { ...base, entityTypes: base.entityTypes.map((entry) => ({ ...entry, pii: [...pii] })) } });
    select(rig.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inInspector().getByText(caption)).toBeTruthy();
  });

  it('shows the masks the server returned for every class and a masked inspector title', async () => {
    const properties = [property('holder', 'I••• L•••', 'name', true), property('email', 'j•••@•••', 'email', true), property('phone', '+1 ••••••45', 'phone', true), property('born', '••••••', 'date', true), property('note', '••••••', 'text', true)];
    const rig = inspectorRig({ nodes: [{ ...entity('n1', properties), display: { title: 'I••• L•••', type: 'kind-a' } }] });
    select(rig.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(lines()).toEqual(['holder|I••• L•••', 'email|j•••@•••', 'phone|+1 ••••••45', 'born|••••••', 'note|••••••']);
    expect(inInspector().getByRole('heading', { name: 'I••• L•••' })).toBeTruthy();
  });

  it('is locked by a property masked by a policy in the entity the inspector shows, though the loaded graph holds none', async () => {
    const rig = inspectorRig({ nodes: [entity('n1', [property('holder', 'Jordan Lee', 'name')])] });
    select(rig.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(screen.getByRole('switch', { name: 'Mask sensitive values' }).getAttribute('aria-disabled')).toBeNull();
    await answerEntity(rig.entityReads[0], entity('n1', [{ ...property('holder', 'J••• L•••', 'name', true), maskedBy: 'policy' as const }]));
    expect(screen.getByRole('switch', { name: 'Mask sensitive values · Locked by policy' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('says nothing of a count while the profile is not known, and "0 sensitive fields are shown" only when it is known to hold none', () => {
    const unknown = inspectorRig({ nodes: [entity('n1')], profile: undefined });
    select(unknown.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inInspector().queryByText(/sensitive field/)).toBeNull();
    cleanup();
    const known = inspectorRig({ nodes: [entity('n1')] });
    select(known.state, 'n1');
    fireEvent.click(screen.getByRole('tab', { name: 'Properties' }));
    expect(inInspector().getByText('0 sensitive fields are shown')).toBeTruthy();
  });

  it.each(['reading', 'failed'])('closes with the close button and with Esc while the view is %s, and the focus goes to the canvas', async (phase) => {
    const { reads, user } = await openSwitch();
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    if (phase === 'failed') await act(async () => reads[0]?.answer({ ok: false, failure: failure('SOURCE_UNAVAILABLE', false) }));
    await user.click(inInspector().getByRole('button', { name: 'Close inspector' }));
    expect(inspector()).toBeNull();
    expect(document.activeElement?.classList.contains('graph-canvas')).toBe(true);
    cleanup();
    const again = await openSwitch();
    await again.user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    if (phase === 'failed') await act(async () => again.reads[0]?.answer({ ok: false, failure: failure('SOURCE_UNAVAILABLE', false) }));
    fireEvent.keyDown(inInspector().getByRole('button', { name: 'Close inspector' }), { key: 'Escape' });
    expect(inspector()).toBeNull();
    expect(document.activeElement?.classList.contains('graph-canvas')).toBe(true);
  });

  it('offers Try again for a failure that says it cannot be tried again', async () => {
    const { reads, user } = await openSwitch();
    await user.click(screen.getByRole('switch', { name: 'Mask sensitive values' }));
    await act(async () => reads[0]?.answer({ ok: false, failure: failure('SOURCE_UNAVAILABLE', false) }));
    expect(inInspector().getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});
