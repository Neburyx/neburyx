import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateRunResponse } from '@neburyx/contracts';
import { choosePreset, okRun, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const summary = (): HTMLElement => screen.getByRole('region', { name: 'Result' });
const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });

async function shown(answer: (call: number) => TemplateRunResponse, pattern?: string) {
  let call = 0;
  const kit = await patternsWorkspace({ run: async () => ({ ok: true, value: answer(++call) }) });
  await openBuiltIn();
  selectAccount(kit.state, 'acc-1');
  if (pattern !== undefined) await choosePreset(pattern);
  await userEvent.click(run());
  await settle();
  return kit;
}

describe('the result of a pattern run', () => {
  it.each([
    [{ value: 3, quality: 'exact' as const, scope: 'matches' }, '3 · exact'],
    [{ value: 3, quality: 'estimated' as const, scope: 'matches' }, '~ 3 (estimated)'],
    [{ value: 3, quality: 'lowerBound' as const, scope: 'matches' }, '≥ 3 · lower bound'],
    [{ quality: 'unknown' as const, scope: 'matches' }, 'no count'],
  ])('states the count %j as %s', async (count, text) => {
    await shown(() => okRun(['acc-2'], { count } as never));
    expect(within(summary()).getByRole('status').textContent).toBe(text);
  });

  it('lists the evidence records as references under the table', async () => {
    await shown(() => okRun(['acc-2', 'acc-3']));
    expect(screen.getByText(/^Evidence:/).textContent).toBe('Evidence: AUTH-0, AUTH-1');
  });

  it('says no matches were found, shows the count as stated and draws no table', async () => {
    await shown(() => okRun([]));
    expect(within(summary()).getByRole('status').textContent).toBe('No matches found. 0 · exact');
    expect(screen.queryByRole('table')).toBeNull();
  });

  it.each([
    [{ code: 'stopListSkipped' }, 'stop list was skipped'],
    [{ code: 'noStopList' }, 'no stop list'],
    [{ code: 'undatedExcluded' }, 'without a usable date'],
    [{ code: 'readBounded' }, 'lower bound'],
    [{ code: 'evidenceCut' }, 'Not every shared attribute'],
    [{ code: 'windowNotApplied', relationshipTypes: ['A', 'B'] }, '2 relationship types'],
    [{ code: 'supernodesSkipped', entities: [] }, 'not traversed'],
  ])('writes the notice %j as a sentence', async (notice, text) => {
    await shown(() => okRun(['acc-2'], { notices: [notice] } as never));
    expect(screen.getByText(new RegExp(text))).toBeTruthy();
  });

  it('shows how a linked match was reached', async () => {
    await shown(() => okRun(['acc-2'], { templateId: 'linked-entities', presetId: 'connected-accounts', links: [{ match: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-2' }, hops: 2, through: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' } }] }), 'Connected accounts');
    expect(screen.getByText('2 hops via acc-1')).toBeTruthy();
  });

  it('shows the titles the response carries, masked as they came', async () => {
    const answer = okRun(['acc-2']);
    if (answer.status !== 'ok') throw new Error('ok');
    const nodes = answer.nodes.map((node) => (node.ref.stableId === 'acc-2' ? { ...node, display: { ...node.display, title: '••••' } } : node));
    await shown(() => ({ ...answer, nodes }));
    expect(within(screen.getByRole('table')).getByText('••••')).toBeTruthy();
  });

  it('keeps the first table until a second run’s answer arrives, then replaces it', async () => {
    let release: (value: { ok: true; value: TemplateRunResponse }) => void = () => undefined;
    let call = 0;
    const kit = await patternsWorkspace({ run: () => (++call === 1 ? Promise.resolve({ ok: true as const, value: okRun(['acc-2']) }) : new Promise((resolve) => (release = resolve))) });
    await openBuiltIn();
    selectAccount(kit.state, 'acc-1');
    await userEvent.click(run());
    await settle();
    await userEvent.click(run());
    await settle();
    expect(within(screen.getByRole('table')).getByText('acc-2')).toBeTruthy();
    release({ ok: true, value: okRun(['acc-3']) });
    await settle();
    expect(within(screen.getByRole('table')).getByText('acc-3')).toBeTruthy();
    expect(within(screen.getByRole('table')).queryByText('acc-2')).toBeNull();
  });
});
