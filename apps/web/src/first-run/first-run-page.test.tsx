import { configure, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourceSummary } from '@neburyx/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INVESTIGATION_A, INVESTIGATION_B, investigationOf, knowing, nodeOf, openedOf } from '../investigations/test-data.js';
import { renderApp, source } from '../test-utils.js';

beforeAll(() => configure({ reactStrictMode: true }));
afterAll(() => configure({ reactStrictMode: false }));

const PRESET = { entityType: 'kind-a', stableId: 'A-1', caseRef: 'CASE-1' } as const;
const demo = (id: string, overrides: Partial<SourceSummary> = {}): SourceSummary => source(id, { synthetic: true, demoCase: PRESET, ...overrides });

function show(sources: readonly SourceSummary[]) {
  const calls = { open: 0, list: 0, sources: 0 };
  const parts = knowing([], {
    getSources: async () => (calls.sources++, { ok: true, value: { items: [...sources], nextCursor: null } }),
    listInvestigations: async () => (calls.list++, { ok: true, value: { items: [], hasMore: false, counts: { investigations: { value: 0, quality: 'exact', scope: 'investigations' }, sources: { value: 0, quality: 'exact', scope: 'investigation-sources' }, savedViews: { count: { value: 0, quality: 'exact', scope: 'named-views' }, lastEditedAt: null } } } }),
    openInvestigation: async () => (calls.open++, { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }),
  });
  const view = renderApp('/', parts.client);
  return { view, calls };
}

const emptyState = () => screen.findByRole('region', { name: 'No investigations yet' });
const header = () => within(document.querySelector<HTMLElement>('.page-heading') ?? document.body);

describe('the First run page with one demo source', () => {
  it('has the heading, the subtitle, the tag, the sentence and the primary and secondary buttons of its empty state', async () => {
    show([demo('source-a')]);
    const region = await emptyState();
    expect(screen.getByRole('heading', { name: 'Investigations', level: 1 })).toBeTruthy();
    expect(header().getByText('No source of your own connected')).toBeTruthy();
    expect(header().getByText('No sign-in')).toBeTruthy();
    expect(within(region).getByText('Open the synthetic demo graph, or connect your own read-only Neo4j.')).toBeTruthy();
    expect(within(region).getByRole('button', { name: 'Open demo case' }).className).toBe('primary');
    expect(within(region).getByRole('button', { name: 'Connect your Neo4j' }).className).toBe('secondary');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
  });

  it('shows the setup command and its line, and the three steps with their titles and texts', async () => {
    show([demo('source-a')]);
    await emptyState();
    const note = screen.getByRole('region', { name: 'Source setup' });
    expect(within(note).getByText('neburyx test-source --name <source>')).toBeTruthy();
    expect(within(note).getByText('Connect through your YAML configuration, then test the read-only source.')).toBeTruthy();
    const steps = within(screen.getByRole('region', { name: 'Getting started' })).getAllByRole('listitem');
    expect(steps.map((step) => [step.querySelector('h3')?.textContent, step.querySelector('p')?.textContent])).toEqual([
      ['Map your schema in YAML', 'Describe the labels and indexed properties you investigate.'],
      ['Search or open a deep link', 'Start with a configured ID or jump straight to an entity.'],
      ['Expand safely and verify relationships', 'Follow relationships and inspect the evidence. Your source stays unchanged.'],
    ]);
  });

  it('moves focus to the setup note on Connect your Neo4j, with no request made and the address unchanged', async () => {
    const { view, calls } = show([demo('source-a')]);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Connect your Neo4j' }));
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Source setup' }));
    expect(calls).toEqual({ open: 0, list: 1, sources: 1 });
    expect(view.router.state.location.pathname).toBe('/');
  });

  it('puts the command on the clipboard on Copy and says Copied', async () => {
    const user = userEvent.setup();
    const written = vi.spyOn(navigator.clipboard, 'writeText');
    show([demo('source-a')]);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(written).toHaveBeenCalledWith('neburyx test-source --name <source>');
    expect(await screen.findByText('Copied')).toBeTruthy();
    written.mockRestore();
  });

  it('says it could not copy, and changes nothing else, when the clipboard refuses or is absent', async () => {
    const user = userEvent.setup();
    const refusing = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    show([demo('source-a')]);
    await user.click(await screen.findByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Could not copy')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open demo case' })).toBeTruthy();
    refusing.mockRestore();
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByText('Could not copy')).toBeTruthy();
    if (original !== undefined) Object.defineProperty(navigator, 'clipboard', original);
    else Reflect.deleteProperty(navigator, 'clipboard');
  });

  it('reaches every control by Tab in reading order, and no text of the page says edition', async () => {
    show([demo('source-a')]);
    const user = userEvent.setup();
    await emptyState();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/edition/i);
    (await screen.findByRole('link', { name: 'Sources' })).focus();
    const order: string[] = [];
    for (let step = 0; step < 4; step += 1) {
      await user.tab();
      order.push(document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
    }
    expect(order.slice(0, 3)).toEqual(['Open demo case', 'Connect your Neo4j', 'Copy']);
  });
});

describe('the First run page by what the install has', () => {
  it('shows no Open demo case, and the sentence for connecting, when no source has a demo case, with the subtitle by the sources', async () => {
    const synthetic = show([source('source-a', { synthetic: true })]);
    await emptyState();
    expect(screen.queryByRole('button', { name: /Open demo case/ })).toBeNull();
    expect(screen.getByText('Connect your own read-only Neo4j.')).toBeTruthy();
    expect(header().getByText('No source of your own connected')).toBeTruthy();
    synthetic.view.unmount();
    show([source('source-a', { synthetic: false, state: 'unavailable' })]);
    await emptyState();
    expect(header().getByText('No source connected')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open demo case/ })).toBeNull();
  });

  it('says no source is connected when there is no source at all', async () => {
    show([]);
    await emptyState();
    expect(header().getByText('No source connected')).toBeTruthy();
  });

  it('shows one button for each demo source with its alias after the label, whatever its state, and the plain label for one', async () => {
    const several = show([demo('source-a', { alias: 'Alpha', state: 'unknown' }), demo('source-b', { alias: 'Beta', state: 'unavailable' }), demo('source-c', { alias: 'Gamma', state: 'connected' })]);
    await emptyState();
    expect(screen.getAllByRole('button', { name: /^Open demo case/ }).map((button) => button.textContent)).toEqual(['Open demo case · Alpha', 'Open demo case · Beta', 'Open demo case · Gamma']);
    several.view.unmount();
    show([demo('source-a', { alias: 'Alpha' })]);
    expect(await screen.findByRole('button', { name: 'Open demo case' })).toBeTruthy();
  });
});

describe('a demo case whose reference a path cannot carry', () => {
  it('opens through the body of the open request and not through a deep link, and says so when that fails', async () => {
    const long = `p1.${'x'.repeat(555)}`;
    const sent: unknown[] = [];
    const parts = knowing([], {
      getSources: async () => ({ ok: true, value: { items: [demo('source-a', { demoCase: { ...PRESET, stableId: long } })], nextCursor: null } }),
      openInvestigation: async (body) => (sent.push(body), { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }),
    });
    const view = renderApp('/', parts.client);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open demo case' }));
    expect(sent).toMatchObject([{ sourceId: 'source-a', caseRef: 'CASE-1', entity: { entityType: 'kind-a', stableId: long } }]);
    expect(view.router.state.location.pathname).toBe('/');
    expect((await screen.findByRole('alert')).textContent).toContain('cannot be put in a link');
  });

  it('applies only the newest of two activations when two demo buttons are clicked and the earlier answer comes first', async () => {
    const sources = [demo('source-a', { demoCase: { ...PRESET, stableId: `p1.${'a'.repeat(555)}` } }), demo('source-b', { demoCase: { ...PRESET, stableId: `p1.${'b'.repeat(555)}` } })];
    const releases = new Map<string, () => void>();
    const parts = knowing([], {
      getSources: async () => ({ ok: true, value: { items: sources, nextCursor: null } }),
      openInvestigation: async (body) => {
        await new Promise<void>((resolve) => releases.set(body.sourceId, resolve));
        const sourceId = body.sourceId;
        const id = sourceId === 'source-a' ? INVESTIGATION_A : INVESTIGATION_B;
        return { ok: true, value: openedOf(investigationOf(id, sourceId, 'kind-a', 'A-1'), nodeOf(sourceId, 'kind-a', 'A-1')) };
      },
    });
    const view = renderApp('/', parts.client);
    const user = userEvent.setup();
    const buttons = await screen.findAllByRole('button', { name: /Open demo case/ });
    await user.click(buttons[0] as HTMLElement);
    await user.click(buttons[1] as HTMLElement);
    releases.get('source-a')?.();
    releases.get('source-b')?.();
    await vi.waitFor(() => expect(view.router.state.location.pathname).toBe(`/explore/${INVESTIGATION_B}`));
  });
});
