import { act, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { source } from '../test-utils.js';
import { answerEdge, detailOf, evidenceRig, inPanel, openOn, OWNS } from './evidence-kit.js';

afterEach(cleanup);

const tested = (server: { product: string; version: string } | null) => ({
  checkedAt: '2026-10-30T10:16:08.000Z',
  outcome: 'pass' as const,
  server,
  versionSupported: server === null ? null : true,
  readOnlyCheck: 'privileges-inspected' as const,
  loginCanWrite: false,
  degreeStatus: 'pass' as const,
  degreeWarnings: [],
});

async function opened(detail = detailOf(OWNS), client = {}) {
  const rig = evidenceRig({ client });
  openOn(rig, OWNS);
  await answerEdge(rig.edgeReads[0], detail);
  return rig;
}

describe('the Properties sub-tab', () => {
  it('lists the ID, the observed time in UTC and every property the edge holds, and makes no request by switching', async () => {
    const detail = detailOf(OWNS, { observedAt: '2026-10-21T08:15:00Z', properties: [{ key: 'remark', value: 'checked', dataClass: 'text', masked: false }, { key: 'items', value: 18, dataClass: 'number', masked: false }] });
    const rig = await opened(detail);
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    const rows = [...document.querySelectorAll('.evidence-properties .inspector-row')].map((row) => row.textContent);
    expect(rows).toEqual(['IDe1', 'Observed21 Oct 2026, 08:15:00 UTC', 'remarkchecked', 'items18']);
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });

  it('says unavailable for an edge with no observed time, and shows a time with no zone as read, never as UTC', async () => {
    const rig = await opened(detailOf(OWNS));
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    expect(inPanel().getByText('Observed').nextSibling?.textContent).toBe('unavailable');
    rig.unbind();
    cleanup();
    const local = await opened(detailOf(OWNS, { observedAt: '2026-10-21T08:15:00' }));
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    expect(inPanel().getByText('Observed').nextSibling?.textContent).toBe('2026-10-21T08:15:00 (no time zone)');
    local.unbind();
  });
});

describe('the Properties sub-tab, for a time that is not a date-time with or without an offset', () => {
  it.each([
    ['a date', '2024-02-06', '2024-02-06'],
    ['text that is not a time', 'last Tuesday', 'last Tuesday'],
    ['a date-time with an offset', '2026-10-21T10:15:00+02:00', '21 Oct 2026, 08:15:00 UTC'],
  ])('shows %s as it should', async (_name, observedAt, shown) => {
    const rig = await opened(detailOf(OWNS, { observedAt }));
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    expect(inPanel().getByText('Observed').nextSibling?.textContent).toBe(shown);
    rig.unbind();
  });
});

describe('the Source sub-tab', () => {
  const sources = (lastTest: ReturnType<typeof tested> | null) => ({ getSources: async () => ({ ok: true as const, value: { items: [source('a', { alias: 'Fincrime', lastTest })], nextCursor: null } }) });

  it('shows the source name, its server product and version and that it is read-only, and nothing else', async () => {
    const rig = await opened(detailOf(OWNS), sources(tested({ product: 'Neo4j', version: '5.26.0' })));
    await act(async () => undefined);
    await act(async () => inPanel().getByRole('tab', { name: 'Source' }).click());
    expect([...document.querySelectorAll('.evidence-source .inspector-row')].map((row) => row.textContent)).toEqual(['SourceFincrime', 'ServerNeo4j 5.26.0']);
    expect(inPanel().getAllByText('Source is read-only')).toHaveLength(2);
    rig.unbind();
  });

  it.each([
    ['no test', null],
    ['a test with no server answer', tested(null)],
  ])('shows the name and the read-only line only for %s', async (_name, lastTest) => {
    const rig = await opened(detailOf(OWNS), sources(lastTest));
    await act(async () => undefined);
    await act(async () => inPanel().getByRole('tab', { name: 'Source' }).click());
    expect([...document.querySelectorAll('.evidence-source .inspector-row')].map((row) => row.textContent)).toEqual(['SourceFincrime']);
    expect(inPanel().getAllByText('Source is read-only')).toHaveLength(2);
    rig.unbind();
  });

  it('does not abort or repeat the read when a sub-tab is chosen while it is pending', async () => {
    const rig = evidenceRig();
    openOn(rig, OWNS);
    const first = rig.edgeCalls[0];
    await act(async () => inPanel().getByRole('tab', { name: 'Properties' }).click());
    await act(async () => inPanel().getByRole('tab', { name: 'Source' }).click());
    await act(async () => inPanel().getByRole('tab', { name: 'Evidence' }).click());
    expect(rig.edgeCalls).toHaveLength(1);
    expect(first?.signal?.aborted).toBe(false);
    await answerEdge(rig.edgeReads[0], detailOf(OWNS));
    expect(inPanel().getByText('R-e1')).toBeTruthy();
    expect(inPanel().getByText('Title n1 → Title n2')).toBeTruthy();
    rig.unbind();
  });

  it('is a tablist moved by the arrows, the selected tab announced', async () => {
    const rig = await opened();
    const evidenceTab = inPanel().getByRole('tab', { name: 'Evidence' });
    expect(evidenceTab.getAttribute('aria-selected')).toBe('true');
    evidenceTab.focus();
    await act(async () => void evidenceTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })));
    await act(async () => undefined);
    expect(inPanel().getByRole('tab', { name: 'Properties' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(inPanel().getByRole('tab', { name: 'Properties' }));
    expect(rig.edgeCalls).toHaveLength(1);
    rig.unbind();
  });
});
