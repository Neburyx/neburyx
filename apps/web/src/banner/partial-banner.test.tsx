import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { errorBodySchema, ERROR_TABLE } from '@neburyx/contracts';
import { clientWith, me, renderApp, source } from '../test-utils.js';
import { createClientState } from '../state/client-state.js';
import { createBuiltInBannerController } from './built-in-causes.js';
import type { ServerFailure } from './banner-controller.js';

function fixture(details?: unknown): ServerFailure {
  const { retryable, message } = ERROR_TABLE.PARTIAL_RESULT;
  return errorBodySchema.parse({ error: { code: 'PARTIAL_RESULT', message, retryable, traceId: 'trace-1', ...(details === undefined ? {} : { details }) } }).error;
}

function open(state = createClientState()) {
  const banner = createBuiltInBannerController();
  renderApp('/explore', clientWith({ me: me(), sources: [source('a')] }), state, undefined, undefined, undefined, undefined, undefined, undefined, undefined, banner);
  return banner;
}

const region = () => screen.queryByRole('region', { name: 'Request status' });
const WORDING = { itemNoun: 'paths', reason: '5 s timeout' };

describe('the Partial banner state', () => {
  it('renders the fixture of 2 retained of 5 requested with the design wording', () => {
    const banner = open();
    act(() => {
      banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: WORDING });
    });
    const shown = within(region() as HTMLElement);
    expect(shown.getByText('Partial')).toBeTruthy();
    expect(shown.getByText('2 / 5 paths retained')).toBeTruthy();
    expect(shown.getByText('5 s timeout · 2 of 5 requested paths retained')).toBeTruthy();
    expect(shown.getByText('Partial, not exhaustive · graph preserved.')).toBeTruthy();
  });

  it('reads 0 of 5 with no leading separator when nothing was retained and no reason is given', () => {
    const banner = open();
    act(() => {
      banner.showFailure(fixture({ retained: 0, requested: 5 }), { partial: { itemNoun: 'paths' } });
    });
    expect(screen.getByText('0 of 5 requested paths retained')).toBeTruthy();
  });

  it('shows the review action the cause supplies, runs it, and shows no Retry', async () => {
    const review = vi.fn();
    const banner = open();
    act(() => {
      banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: { ...WORDING, review: { label: 'Review 2 paths', run: review } }, resend: vi.fn() });
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Review 2 paths' }));
    expect(review).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('shows no action when the cause supplies none', () => {
    const banner = open();
    act(() => {
      banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: WORDING });
    });
    expect(within(region() as HTMLElement).getAllByRole('button').map((button) => button.textContent)).toEqual(['Dismiss']);
  });

  it('shows no banner and guesses no number when the counts are missing or break the contract', () => {
    const banner = open();
    // The contract refuses these bodies, so a client that is sent one reads it as untyped JSON.
    const unchecked = (details: unknown): ServerFailure => JSON.parse(JSON.stringify({ code: 'PARTIAL_RESULT', message: 'm', retryable: true, traceId: 't', details }));
    for (const details of [undefined, {}, { retained: 2 }, { retained: 5, requested: 5 }, { retained: '2', requested: 5 }]) {
      expect(banner.showFailure(unchecked(details), { partial: WORDING })).toBe(false);
    }
    expect(region()).toBeNull();
  });

  it('shows no banner when the cause supplies no item noun, or a blank one', () => {
    const banner = open();
    expect(banner.showFailure(fixture({ retained: 2, requested: 5 }))).toBe(false);
    expect(banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: { itemNoun: '  ' } })).toBe(false);
    expect(region()).toBeNull();
  });

  it('leaves the graph, filters, selection and draft as they were through show, replace and dismiss', () => {
    const state = createClientState();
    const before = { server: state.server.getState(), investigation: state.investigation.getState(), presentation: state.presentation.view.getState() };
    const banner = open(state);
    act(() => {
      banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: WORDING });
      banner.showFailure(fixture({ retained: 3, requested: 5 }), { partial: WORDING });
      banner.dismiss('partial');
    });
    expect(state.server.getState()).toBe(before.server);
    expect(state.investigation.getState()).toBe(before.investigation);
    expect(state.presentation.view.getState()).toBe(before.presentation);
    expect(region()).toBeNull();
  });

  it('announces the state politely', () => {
    const banner = open();
    act(() => {
      banner.showFailure(fixture({ retained: 2, requested: 5 }), { partial: WORDING });
    });
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toContain('Partial. 5 s timeout · 2 of 5 requested paths retained.');
  });
});

describe('the Partial state is not wired to any request', () => {
  it('is named in no source file outside the banner and the contract', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) files.push(path);
      }
    };
    walk(join(import.meta.dirname, '..'));
    const mentions = files.filter((file) => !file.includes(`${join('src', 'banner')}`) && readFileSync(file, 'utf8').includes('PARTIAL_RESULT'));
    expect(mentions).toEqual([]);
  });
});
