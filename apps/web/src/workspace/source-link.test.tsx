import { act, cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourceProfile } from '@neburyx/contracts';
import { parseSourceLinkSegment } from '@neburyx/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerEdge, detailOf, evidenceRig, inPanel, OWNS, openOn } from '../evidence/evidence-kit.js';
import { entity, inInspector, inspectorRig, keyOf, profileOf, select, TYPE } from '../inspector/inspector-kit.js';
import { edgeKey } from '../state/keys.js';
import { entityLinkHref, offersEntityLink, offersRecordLink, recordLinkHref } from './source-link.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const withLink = (recordLink: 'none' | 'always' | 'unmasked', relationshipLink = false): SourceProfile => {
  const base = profileOf();
  return { ...base, entityTypes: base.entityTypes.map((type) => ({ ...type, recordLink })), relationshipTypes: [{ type: 'OWNS', from: TYPE, to: TYPE, aggregate: false, observedAt: null, stableIdProperty: 'id', filterable: [], sortable: [], evidence: [], properties: ['id'], recordLink: relationshipLink }] };
};

const segmentOf = (href: string): string => decodeURIComponent((href.split('?')[0] ?? '').replace('/v1/source-links/', ''));
const REF = { sourceId: 'a', entityType: TYPE, stableId: 'n1' };

describe('the addresses of the source links', () => {
  it('names the app\'s own path with the reference in one segment, mask only when masked, and never an address of the source', () => {
    expect(entityLinkHref(REF, false)).toMatch(/^\/v1\/source-links\/[A-Za-z0-9_-]+$/);
    expect(parseSourceLinkSegment(segmentOf(entityLinkHref(REF, false)))).toEqual({ form: 'entity', ref: REF });
    expect(entityLinkHref(REF, true)).toMatch(/\?mask=true$/);
    const edge = { sourceId: 'a', type: 'OWNS', from: TYPE, to: TYPE, stableId: 'e/1' };
    const href = recordLinkHref(edge, 'R 1&x', true);
    expect(href).toContain('?record=R%201%26x&mask=true');
    expect(parseSourceLinkSegment(segmentOf(href))).toEqual({ form: 'stored', ref: edge });
  });

  it('offers an entity link by the profile flag and the masking, and a record link by the relationship flag', () => {
    expect(offersEntityLink(withLink('always'), REF, true)).toBe(true);
    expect(offersEntityLink(withLink('unmasked'), REF, false)).toBe(true);
    expect(offersEntityLink(withLink('unmasked'), REF, true)).toBe(false);
    expect(offersEntityLink(withLink('none'), REF, false)).toBe(false);
    expect(offersEntityLink(undefined, REF, false)).toBe(false);
    const edge = { sourceId: 'a', type: 'OWNS', from: TYPE, to: TYPE, stableId: 'e1' };
    expect(offersRecordLink(withLink('none', true), edge)).toBe(true);
    expect(offersRecordLink(withLink('none', false), edge)).toBe(false);
  });
});

describe('the inspector header and the node menu', () => {
  it('shows Open source record as a link that opens in a new tab without an opener or a referrer, when the type has a link', () => {
    const rig = inspectorRig({ profile: withLink('always') });
    select(rig.state, 'n1');
    const link = inInspector().getByRole('link', { name: 'Open source record' });
    expect(link.getAttribute('href')).toBe(entityLinkHref(REF, false));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('shows no link, and the ID stays text, for a type without a link', () => {
    const rig = inspectorRig({ profile: withLink('none') });
    select(rig.state, 'n1');
    expect(inInspector().queryByRole('link', { name: 'Open source record' })).toBeNull();
    expect(inInspector().getByText('n1')).toBeTruthy();
  });

  it('shows the link of a keyed type while unmasked and not while masked', () => {
    const unmasked = inspectorRig({ profile: withLink('unmasked') });
    select(unmasked.state, 'n1');
    expect(inInspector().getByRole('link', { name: 'Open source record' }).getAttribute('href')).toBe(entityLinkHref(REF, false));
    cleanup();
    const state = unmasked.state;
    act(() => state.setMask(true));
    const masked = inspectorRig({ profile: withLink('unmasked'), state });
    select(masked.state, 'n1');
    expect(inInspector().queryByRole('link', { name: 'Open source record' })).toBeNull();
  });

  it('lists the item in the entity menu when the type has a link, opens it with noopener and noreferrer, and lists nothing without one', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const rig = inspectorRig({ profile: withLink('always'), nodes: [entity('n1'), entity('n2')] });
    act(() => rig.state.presentation.setOpenMenu({ kind: 'node', key: keyOf('n1'), x: 10, y: 10 }));
    await userEvent.setup().click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open source record' }));
    expect(open).toHaveBeenCalledWith(entityLinkHref(REF, false), '_blank', 'noopener,noreferrer');
    cleanup();
    const none = inspectorRig({ profile: withLink('none') });
    act(() => none.state.presentation.setOpenMenu({ kind: 'node', key: keyOf('n1'), x: 10, y: 10 }));
    expect(screen.queryByRole('menuitem', { name: 'Open source record' })).toBeNull();
  });

  it('reaches the menu item by keyboard', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const rig = inspectorRig({ profile: withLink('always') });
    act(() => rig.state.presentation.setOpenMenu({ kind: 'node', key: keyOf('n1'), x: 10, y: 10 }));
    await act(async () => undefined);
    const item = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open source record' });
    item.focus();
    await userEvent.keyboard('{Enter}');
    expect(window.open).toHaveBeenCalled();
  });
});

describe('the records of a relationship', () => {
  const linked = (rig: ReturnType<typeof evidenceRig>) => answerEdge(rig.edgeReads[0], detailOf(OWNS, { evidence: { status: 'available', records: [{ sourceRecordId: 'AUTH-1', linkable: true }, { sourceRecordId: 'TXT-2', linkable: false }, { property: 'doc', unreadable: true }] } }));

  it('links a record the read marks linkable and leaves the others as text', async () => {
    const rig = evidenceRig({ profile: withLink('none', true) });
    openOn(rig, OWNS);
    await linked(rig);
    const link = inPanel().getByRole('link', { name: 'AUTH-1' });
    expect(link.getAttribute('href')).toBe(recordLinkHref(OWNS.ref as never, 'AUTH-1', false));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(inPanel().queryByRole('link', { name: 'TXT-2' })).toBeNull();
    expect(inPanel().getByText('TXT-2')).toBeTruthy();
    rig.unbind();
  });

  it('shows the whole list as text while the read is pending', () => {
    const rig = evidenceRig({ profile: withLink('none', true) });
    openOn(rig, OWNS);
    expect(inPanel().queryByRole('link')).toBeNull();
    rig.unbind();
  });

  it('lists Open source record in the relationship menu only for a type with an evidence link, and opens the panel when no read is held, starting nothing else', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const rig = evidenceRig({ profile: withLink('none', true) });
    act(() => rig.state.presentation.setOpenMenu({ kind: 'relationship', key: edgeKey(OWNS.ref), x: 40, y: 40 }));
    await userEvent.setup().click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open source record' }));
    expect(open).not.toHaveBeenCalled();
    expect(rig.edgeCalls).toHaveLength(1);
    expect(screen.getByRole('complementary', { name: 'Relationship evidence' })).toBeTruthy();
    rig.unbind();
    cleanup();
    const none = evidenceRig({ profile: withLink('none', false) });
    act(() => none.state.presentation.setOpenMenu({ kind: 'relationship', key: edgeKey(OWNS.ref), x: 40, y: 40 }));
    expect(screen.queryByRole('menuitem', { name: 'Open source record' })).toBeNull();
    none.unbind();
  });

  it('opens the record at once when the read held has exactly one linkable record, and opens the panel when it has two', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const rig = evidenceRig({ profile: withLink('none', true) });
    openOn(rig, OWNS);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS, { evidence: { status: 'available', records: [{ sourceRecordId: 'AUTH-1', linkable: true }, { sourceRecordId: 'TXT-2', linkable: false }] } }));
    act(() => rig.evidence.close());
    act(() => rig.state.presentation.setOpenMenu({ kind: 'relationship', key: edgeKey(OWNS.ref), x: 40, y: 40 }));
    await userEvent.setup().click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Open source record' }));
    expect(open).toHaveBeenCalledWith(recordLinkHref(OWNS.ref as never, 'AUTH-1', false), '_blank', 'noopener,noreferrer');
    expect(rig.edgeCalls).toHaveLength(1);
    expect(screen.queryByRole('complementary', { name: 'Relationship evidence' })).toBeNull();
    rig.unbind();
  });
});
