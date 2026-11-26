import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InvestigationListResponse, TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../api/client.js';
import { READ_WAIT_MS } from '../api/read-wait.js';
import { testProfile } from '../dev/test-profile.js';
import { INVESTIGATION_A, investigationOf, listItemOf, listOf } from '../investigations/test-data.js';
import { listOf as templatesOf } from '../patterns/patterns-kit.js';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { drawn, end, ENDINGS, expectBlock, held, press, statuses, timesSaid } from '../waiting-kit.js';

beforeEach(() => void vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const RECENT = 'Loading recent investigations…';
const PATTERNS = 'Loading patterns…';
const ROW = listItemOf(investigationOf(INVESTIGATION_A, 'a', 'kind-a', 'A-1'));

const base = (): ApiClient => ({
  ...clientWith({ me: me() }),
  getSources: async () => ({ ok: true, value: { items: [source('a', { alias: 'alpha' })], nextCursor: null } }),
  listInvestigations: async () => ({ ok: true, value: listOf([ROW]) }),
  getProfile: async (sourceId) => ({ ok: true, value: testProfile(sourceId) }),
  listTemplates: async () => ({ ok: true, value: templatesOf() }),
});

const card = (title: string): HTMLElement => within(screen.getByRole('group', { name: 'Library' })).getByRole('heading', { name: title, level: 3 }).closest('.library-card') as HTMLElement;

/** Home after a first read of the list that failed and a Try again whose read is still out: the page is drawn and the list has never been answered. */
async function listOut() {
  const reads = held<InvestigationListResponse>();
  let count = 0;
  renderApp('/', { ...base(), listInvestigations: (_limit, signal) => (++count === 1 ? Promise.resolve({ ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } }) : reads.read(signal)) });
  await drawn();
  await press(within(screen.getByRole('region', { name: 'Recent' })).getByRole('button', { name: 'Try again' }));
  return reads;
}

describe('Home: the recent list while its first read is out', () => {
  it.each(ENDINGS)('says so once over hidden skeleton rows, and stops on: %s', async (how) => {
    const reads = await listOut();
    const recent = () => screen.getByRole('region', { name: 'Recent' });
    const waiting = () => {
      const block = expectBlock(RECENT, recent());
      expect(block.querySelectorAll('.skeleton-card')).toHaveLength(5);
      expect(statuses(RECENT)).toHaveLength(1);
    };
    waiting();
    await end(how, reads.calls[0], listOf([ROW]), READ_WAIT_MS, waiting);
    expect(timesSaid(RECENT)).toBe(0);
    expect(recent().querySelector('.loading-shape, [aria-busy="true"]')).toBeNull();
    if (how === 'answer') expect(within(recent()).getByRole('link', { name: ROW.title })).toBeTruthy();
    else expect(within(recent()).getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('Home: the library cards of the investigations and the saved views while the list is out', () => {
  it.each(ENDINGS)('are busy over hidden bars, with words for a screen reader and no status of their own, and stop on: %s', async (how) => {
    const reads = await listOut();
    const waiting = () => {
      for (const title of ['Investigations', 'Saved views']) {
        const block = card(title).querySelector('.loading-block') as Element;
        expect(block.getAttribute('aria-busy')).toBe('true');
        expect(block.querySelector('.visually-hidden')?.textContent).toBe('Loading…');
        const bars = [...block.querySelectorAll('.skeleton-bar')];
        expect(bars).toHaveLength(2);
        for (const bar of bars) expect(bar.getAttribute('aria-hidden')).toBe('true');
        expect(card(title).querySelector('[role="status"]')).toBeNull();
      }
    };
    waiting();
    await end(how, reads.calls[0], listOf([ROW]), READ_WAIT_MS, waiting);
    for (const title of ['Investigations', 'Saved views']) {
      expect(card(title).querySelector('[aria-busy="true"], .skeleton-bar')).toBeNull();
      expect(within(card(title)).queryByText('Loading…')).toBeNull();
      if (how !== 'answer') expect(within(card(title)).getByText('Not read')).toBeTruthy();
      else expect(card(title).querySelector('.library-figure')).not.toBeNull();
    }
  });
});

describe('Home: the patterns while their first read is out', () => {
  it.each(ENDINGS)('shows a busy library card and one status in the pattern card, and stops on: %s', async (how) => {
    const reads = held<TemplateListResponse>();
    renderApp('/', { ...base(), listTemplates: (_id, signal) => reads.read(signal) });
    await drawn();
    const pattern = () => screen.getByRole('region', { name: 'Start from a pattern' });
    const waiting = () => {
      const block = card('Patterns').querySelector('.loading-block') as Element;
      expect(block.getAttribute('aria-busy')).toBe('true');
      expect(block.textContent).toBe(PATTERNS);
      expect(block.querySelector('.skeleton-bar')?.getAttribute('aria-hidden')).toBe('true');
      expect(statuses(PATTERNS)).toHaveLength(1);
      expect(statuses(PATTERNS, pattern())).toHaveLength(1);
    };
    waiting();
    await end(how, reads.calls[0], templatesOf(), READ_WAIT_MS, waiting);
    expect(timesSaid(PATTERNS)).toBe(0);
    expect(card('Patterns').querySelector('[aria-busy="true"], .skeleton-bar')).toBeNull();
    if (how !== 'answer') expect(within(card('Patterns')).getByText('Not read')).toBeTruthy();
    else expect(card('Patterns').querySelector('.library-figure')?.textContent).toBe('3');
  });
});
