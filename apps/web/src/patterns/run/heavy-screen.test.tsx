import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PatternRunResponse } from '@neburyx/contracts';
import { assertNoCodes } from '../no-codes.js';
import { definitionHeavy, definitionOk, settle } from '../patterns-kit.js';
import { cleanup, inRun, panelHeader, previewedSaved, ran, runButton, runWorkspace, screen, startCombo, userEvent } from './run-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

const heavyAt = (threshold: number, continueLimit: number): PatternRunResponse => ({ status: 'heavy', templateVersion: '1', estimate: { value: threshold, quality: 'lowerBound', scope: 'matches' }, threshold, continueLimit, notices: [], warnings: [] });

describe('the heavy stop of a pattern run', () => {
  it('shows the estimate as a lower bound with its labels, the two choices, Cancel and no match', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await ran();
    expect(panelHeader()).toEqual({ title: 'Run paused', subtitle: 'Draft · from x-1' });
    const here = inRun();
    expect(here.getByText('Estimated ≥ 500 matches')).toBeTruthy();
    expect(document.activeElement).toBe(here.getByText('Estimated ≥ 500 matches'));
    expect(here.getByText('Estimated')).toBeTruthy();
    expect(here.getByText('Lower bound')).toBeTruthy();
    expect(here.getByText('This pattern may match a lot from x-1. The number is not known; it could be higher.')).toBeTruthy();
    expect(here.getByText('The run stopped before reading matches, to protect the source. Nothing was changed.')).toBeTruthy();
    expect(here.getByText('Add conditions or a date window, then run again. No matches are shown yet.')).toBeTruthy();
    expect(here.getByText('Shows the first 25 matches. The count stays a lower bound: “at least 500”.')).toBeTruthy();
    expect(here.getByRole('button', { name: 'Refine filters' })).toBeTruthy();
    expect(here.getByRole('button', { name: 'Continue with 25' })).toBeTruthy();
    expect(here.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(here.queryByRole('list', { name: 'Matches' })).toBeNull();
    assertNoCodes(document.body.textContent ?? '', 'the heavy screen');
  });

  it('takes the numbers from the answer: the estimate and the page it offers', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: heavyAt(1200, 10) }) });
    await ran();
    expect(inRun().getByText('Estimated ≥ 1,200 matches')).toBeTruthy();
    expect(inRun().getByRole('button', { name: 'Continue with 10' })).toBeTruthy();
    expect(inRun().getByText('Shows the first 10 matches. The count stays a lower bound: “at least 1,200”.')).toBeTruthy();
  });

  it('names a saved pattern under the heading', async () => {
    await previewedSaved({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await userEvent.click(runButton());
    await settle();
    expect(panelHeader()).toEqual({ title: 'Run paused', subtitle: 'Alpha · from x-1' });
  });

  it('goes back to the editor on Refine filters, with the same draft and no matches shown', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Refine filters' }));
    await settle();
    expect(panelHeader().title).toBe('New pattern');
    expect(screen.queryByText(/^Estimated/)).toBeNull();
    expect(screen.getByRole('tab', { name: /^Step 1/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('radio', { name: 'Outgoing' }).getAttribute('aria-checked')).toBe('true');
  });

  it('sends one continue run with the same definition and entity, continue and the limit, and shows the first page as a lower bound', async () => {
    let call = 0;
    const kit = await runWorkspace({
      runDefinition: async () => ({ ok: true, value: ++call === 1 ? definitionHeavy() : definitionOk(['acc-2', 'acc-3'], { count: { value: 500, quality: 'lowerBound', scope: 'matches' } } as never) }),
    });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Continue with 25' }));
    await settle();
    expect(kit.definitionRuns).toHaveLength(2);
    expect(kit.definitionRuns[1]?.request).toEqual({ ...kit.definitionRuns[0]?.request, continue: true, limit: 25 });
    expect(panelHeader()).toEqual({ title: 'Pattern result', subtitle: 'Draft · from x-1' });
    expect(inRun().getByText('At least 500 matches')).toBeTruthy();
    expect(inRun().getByText('Lower bound')).toBeTruthy();
    expect(inRun().queryByText(/^Estimated/)).toBeNull();
  });

  it('returns to the preview on Cancel, with the choice of the start kept and nothing run', async () => {
    const kit = await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionHeavy() }) });
    await ran();
    await userEvent.click(inRun().getByRole('button', { name: 'Cancel' }));
    await settle();
    expect(panelHeader().title).toBe('Preview pattern');
    expect(startCombo()).toBeTruthy();
    expect(kit.definitionRuns).toHaveLength(1);
    expect(runButton().disabled).toBe(false);
  });

  it('shows no heavy stop for an ok answer whatever its count quality', async () => {
    await runWorkspace({ runDefinition: async () => ({ ok: true, value: definitionOk(['acc-2'], { count: { quality: 'unknown', scope: 'matches' } } as never) }) });
    await ran();
    expect(screen.queryByText(/Estimated ≥/)).toBeNull();
    expect(panelHeader().title).toBe('Pattern result');
  });
});
