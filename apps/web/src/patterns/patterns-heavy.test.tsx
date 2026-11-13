import { cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { ApiResult } from '../api/client.js';
import type { TemplateRunResponse } from '@neburyx/contracts';
import { choosePreset, heavyRun, okRun, openBuiltIn, openPatterns, patternsWorkspace, selectAccount, settle } from './patterns-kit.js';

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const run = (): HTMLElement => screen.getByRole('button', { name: 'Run pattern' });

async function heavyPanel(answers: (call: number) => ApiResult<TemplateRunResponse> = (call) => ({ ok: true, value: call === 1 ? heavyRun() : okRun(['acc-2']) })) {
  let call = 0;
  const kit = await patternsWorkspace({ run: async () => answers(++call) });
  await openBuiltIn();
  selectAccount(kit.state, 'acc-1');
  await userEvent.type(screen.getByLabelText('Max matching accounts'), '100');
  await userEvent.click(run());
  await settle();
  return kit;
}

describe('the heavy-operation warning in the panel', () => {
  it('shows the estimate with its quality, the threshold, the two buttons and no table', async () => {
    await heavyPanel();
    expect(screen.getByText('Estimated ≥ 500 matches · warning threshold 500')).toBeTruthy();
    expect(screen.getByText('Refine filters or continue with a bounded limit of 25.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refine filters' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with 25' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('closes the warning on Refine filters, moves the focus to the first field and keeps the values', async () => {
    await heavyPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Refine filters' }));
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Starting account'));
    expect((screen.getByLabelText('Max matching accounts') as HTMLInputElement).value).toBe('100');
  });

  it('sends one continue run with the same parameters, the continue flag and a limit of 25, and shows its result', async () => {
    const kit = await heavyPanel();
    await userEvent.click(screen.getByRole('button', { name: 'Continue with 25' }));
    await settle();
    expect(kit.sent).toHaveLength(2);
    expect(kit.sent[1]?.request).toEqual({ sourceId: 'a', params: { ref: { entityType: 'kind-a', stableId: 'acc-1' }, limit: 25 }, continue: true });
    expect(screen.queryByText(/Estimated/)).toBeNull();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('shows no warning for an ok answer whatever its count quality', async () => {
    await heavyPanel(() => ({ ok: true, value: okRun(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } } as never) }));
    expect(screen.queryByText(/Estimated/)).toBeNull();
  });

  it('raises no canvas banner for a heavy answer', async () => {
    const kit = await heavyPanel();
    expect(kit.banner.view.getState().banner).toBeUndefined();
  });

  it('takes the warning down when the pattern, a parameter or the starting entity changes', async () => {
    await heavyPanel(() => ({ ok: true, value: heavyRun() }));
    await userEvent.type(screen.getByLabelText('Max matching accounts'), '1');
    expect(screen.queryByText(/Estimated/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await choosePreset('Shared addresses');
    expect(screen.queryByText(/Estimated/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Run pattern' }));
    await settle();
    await userEvent.selectOptions(screen.getByLabelText('Starting account'), 'acc-2');
    expect(screen.queryByText(/Estimated/)).toBeNull();
  });
});
