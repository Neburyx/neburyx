import { act, configure, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InvestigationListItem, SourceProfile } from '@neburyx/contracts';
import { testProfile } from '../dev/test-profile.js';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, listItemOf, nodeOf, listOf } from '../investigations/test-data.js';
import { renderApp, source } from '../test-utils.js';
import { legendGlyph } from '../workspace/legend-panel.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));
afterEach(() => vi.useRealTimers());

const base = investigationOf(INVESTIGATION_A, 'source-a', 'kind-a', 'A-1', { createdAt: '2026-11-05T10:00:00.000Z', lastEditedAt: '2026-11-05T11:55:00.000Z' });
const known = (investigation = base) => ({ investigation, node: nodeOf(investigation.sourceId, 'kind-a', 'A-1') });

function profileWith(overrides: Partial<SourceProfile> = {}, sourceId = 'source-a'): SourceProfile {
  const profile = testProfile(sourceId);
  return { ...profile, entityTypes: profile.entityTypes.map((type) => (type.type === 'kind-a' ? { ...type, displayName: 'Kind A', icon: 'person' as const } : type)), ...overrides };
}

async function shown(items: InvestigationListItem[], overrides = {}) {
  const parts = knowing(
    items.map((item) => known(item)),
    { listInvestigations: async () => ({ ok: true, value: listOf(items) }), getProfile: async (sourceId: string) => ({ ok: true, value: profileWith({}, sourceId) }), ...overrides },
  );
  renderApp('/', parts.client);
  await screen.findByRole('link', { name: items[0]?.title ?? '' });
  return parts;
}

const row = (index = 0): HTMLElement => document.querySelectorAll<HTMLElement>('.recent-row')[index] ?? document.body;

describe('a Recent row: the starting entity', () => {
  it('shows the stable ID, the type\'s glyph and its display name from the profile of the row\'s source', async () => {
    await shown([listItemOf(base)]);
    await screen.findByText('Kind A');
    expect(row().querySelector('.recent-entity')?.textContent).toContain('A-1');
    expect(row().querySelector('img')?.getAttribute('src')).toBe(legendGlyph('person'));
  });

  it('shows the type as stored and the generic glyph, and no failure on Home, when the profile cannot be read', async () => {
    await shown([listItemOf(base)], { getProfile: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    await screen.findByText('kind-a', { selector: '.recent-type' });
    expect(row().querySelector('img')?.getAttribute('src')).toBe(legendGlyph('generic'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(row().textContent).toContain('Unsaved');
  });

  it('shows the type as stored when the profile does not name it, and no entity piece for an investigation with no starting entity', async () => {
    await shown([listItemOf(base), listItemOf({ ...base, id: INVESTIGATION_B, title: 'Second', startingEntity: null })], { getProfile: async (sourceId: string) => ({ ok: true, value: profileWith({ entityTypes: [] }, sourceId) }) });
    expect(row(0).querySelector('.recent-type')?.textContent).toBe('kind-a');
    expect(row(1).querySelector('.recent-entity')).toBeNull();
  });

  it('reads the profile of a source once for two rows of it, and once for each source', async () => {
    const second = investigationOf(INVESTIGATION_B, 'source-a', 'kind-a', 'A-2');
    const third = investigationOf('0192f000-0000-7000-8000-0000000000c1', 'source-b', 'kind-a', 'C-1');
    const asked: string[] = [];
    await shown([listItemOf(base), listItemOf(second), listItemOf(third)], { getProfile: async (sourceId: string) => (asked.push(sourceId), { ok: true, value: profileWith({}, sourceId) }) });
    await screen.findAllByText('Kind A');
    expect([...asked].sort()).toEqual(['source-a', 'source-b']);
  });
});

describe('a Recent row: the case reference', () => {
  it('shows it under the vocabulary\'s label for the source', async () => {
    await shown([listItemOf({ ...base, caseRef: 'CASE-9' })], { getProfile: async (sourceId: string) => ({ ok: true, value: profileWith({ vocabulary: { caseRef: 'Referral' } }, sourceId) }) });
    await screen.findByText('Referral');
    expect(row().querySelector('.recent-case')?.textContent).toBe('Referral CASE-9');
  });

  it('shows it under "Case reference" when the source names no label', async () => {
    await shown([listItemOf({ ...base, caseRef: 'CASE-9' })]);
    await screen.findByText('Kind A');
    expect(row().querySelector('.recent-case')?.textContent).toBe('Case reference CASE-9');
  });

  it('falls back to the generic label when the profile cannot be read', async () => {
    await shown([listItemOf({ ...base, caseRef: 'CASE-9' })], { getProfile: async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) });
    expect(row().querySelector('.recent-case')?.textContent).toBe('Case reference CASE-9');
  });

  it('shows neither the label nor a value for an investigation with no case reference', async () => {
    await shown([listItemOf(base)]);
    await screen.findByText('Kind A');
    expect(row().querySelector('.recent-case')).toBeNull();
  });
});

describe('a Recent row: the time and the state', () => {
  it('says "Last edited" with the time since the investigation was last edited, never since it was created, and keeps the order the list gave', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-11-05T12:12:00.000Z') });
    const newerEdit = { ...base, title: 'Edited later', id: INVESTIGATION_B, createdAt: '2026-11-05T09:00:00.000Z', lastEditedAt: '2026-11-05T11:59:00.000Z' };
    await shown([listItemOf(newerEdit), listItemOf(base)]);
    expect(row(0).querySelector('.recent-time')?.textContent).toBe('Last edited 13 min ago');
    expect(row(1).querySelector('.recent-time')?.textContent).toBe('Last edited 17 min ago');
    expect(row(0).querySelector('time')?.getAttribute('dateTime')).toBe('2026-11-05T11:59:00.000Z');
    expect(row(1).querySelector('time')?.getAttribute('title')).toBe('2026-11-05 11:55 UTC');
    expect(row(0).textContent).toContain('Edited later');
  });

  it('reads the unsaved state as "Unsaved" and the saved state with the UTC time of the view', async () => {
    await shown([listItemOf(base), listItemOf({ ...base, id: INVESTIGATION_B, title: 'Saved one' }, { save: { state: 'saved', savedAt: '2026-11-05T09:42:00.000Z' } })]);
    expect(row(0).querySelector('.badge')?.textContent).toBe('Unsaved');
    expect(row(1).querySelector('.badge')?.textContent).toBe('Saved · 09:42 UTC');
    expect([...document.querySelectorAll('.recent-row .badge')].filter((badge) => badge.textContent?.startsWith('Saved') === true)).toHaveLength(1);
  });
});

describe('a Recent row: the note and an unavailable source', () => {
  it('shows no line about what a row restores, since the whole draft is kept', async () => {
    await shown([listItemOf(base)]);
    expect(screen.queryByText(/Entities added later/)).toBeNull();
    expect(document.querySelector('.recent-note-line')).toBeNull();
  });

  it.each([
    ['removed', 'Source no longer available as it was'],
    ['repointed', 'Source no longer available as it was'],
  ] as const)('says so on a row whose source is %s, and the row stays a link', async (sourceState, text) => {
    await shown([listItemOf({ ...base, sourceState })]);
    expect(row().querySelector('.recent-note')?.textContent).toBe(text);
    expect(row().querySelector('a')?.getAttribute('href')).toBe(`/explore/${INVESTIGATION_A}`);
  });

  it('shows the state and the reason of a listed source that is not connected, and nothing for a connected one', async () => {
    const down = source('source-a', { state: 'unavailable', stateReason: 'connection refused' });
    const degraded = source('source-b', { state: 'degraded', stateReason: null });
    const second = investigationOf(INVESTIGATION_B, 'source-b', 'kind-a', 'C-1');
    const third = investigationOf('0192f000-0000-7000-8000-0000000000c1', 'source-c', 'kind-a', 'D-1');
    await shown([listItemOf(base), listItemOf(second), listItemOf(third)], { getSources: async () => ({ ok: true, value: { items: [down, degraded, source('source-c')], nextCursor: null } }) });
    expect(row(0).querySelector('.recent-note')?.textContent).toBe('Source unavailable · connection refused');
    expect(row(1).querySelector('.recent-note')?.textContent).toBe('Source degraded');
    expect(row(2).querySelector('.recent-note')).toBeNull();
  });

  it('names a listed source whose state is not yet known', async () => {
    await shown([listItemOf(base)], { getSources: async () => ({ ok: true, value: { items: [source('source-a', { state: 'unknown' })], nextCursor: null } }) });
    expect(row().querySelector('.recent-note')?.textContent).toBe('Source state unknown');
  });

  it('shows the state of a source that is not yet known with its reason', async () => {
    await shown([listItemOf(base)], { getSources: async () => ({ ok: true, value: { items: [source('source-a', { state: 'unknown', stateReason: 'not tested yet' })], nextCursor: null } }) });
    expect(row().querySelector('.recent-note')?.textContent).toBe('Source state unknown · not tested yet');
  });
});

describe('a Recent row: a profile that is read again at the next visit', () => {
  const visit = async (view: ReturnType<typeof renderApp>, to: string) => act(async () => view.router.navigate(to));

  async function secondVisit(second: (sourceId: string) => ReturnType<NonNullable<ReturnType<typeof knowing>['client']['getProfile']>>) {
    let reads = 0;
    const parts = knowing([known(base)], {
      listInvestigations: async () => ({ ok: true, value: listOf([listItemOf({ ...base, caseRef: 'CASE-9' })]) }),
      getProfile: async (sourceId: string) => (++reads === 1 ? { ok: true as const, value: profileWith({ vocabulary: { caseRef: 'Referral' } }, sourceId) } : second(sourceId)),
    });
    const view = renderApp('/', parts.client);
    await screen.findByText('Kind A');
    await visit(view, '/sources');
    await visit(view, '/');
    return view;
  }

  it('falls back to what is stored when the new read fails, keeping the rest of the row', async () => {
    await secondVisit(async () => ({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }));
    await screen.findByText('kind-a', { selector: '.recent-type' });
    expect(row().querySelector('img')?.getAttribute('src')).toBe(legendGlyph('generic'));
    expect(row().querySelector('.recent-case')?.textContent).toBe('Case reference CASE-9');
    expect(row().textContent).toContain('Unsaved');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('falls back to what is stored when the new answer names another source', async () => {
    await secondVisit(async () => ({ ok: true, value: profileWith({}, 'other-source') }));
    await screen.findByText('kind-a', { selector: '.recent-type' });
    expect(row().querySelector('.recent-case')?.textContent).toBe('Case reference CASE-9');
  });

  it('keeps the profile that was read until the new read answers', async () => {
    await secondVisit(() => new Promise(() => undefined));
    expect(row().querySelector('.recent-type')?.textContent).toBe('Kind A');
    expect(row().querySelector('.recent-case')?.textContent).toBe('Referral CASE-9');
  });
});
