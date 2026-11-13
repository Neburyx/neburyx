import { act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiResult } from '../../api/client.js';
import type { PatternValidateResponse } from '@neburyx/contracts';
import { failure, settle } from '../patterns-kit.js';
import { addStepButton, afterDebounce, buildStep, builderWorkspace, chooseArrival, chooseDirection, chooseStart, cleanup, field, openBuilder, screen, startSelect, stepCard, toggleType, userEvent, within } from './builder-kit.js';

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  vi.useRealTimers();
});

type Answer = ApiResult<PatternValidateResponse>;
const invalid = (...problems: { path: (string | number)[]; code: string }[]): Answer => ({ ok: true, value: { status: 'invalid', problems } as PatternValidateResponse });

async function oneStep(options: Parameters<typeof builderWorkspace>[0] = {}) {
  const kit = await builderWorkspace(options);
  await openBuilder();
  await chooseStart('n-a');
  await buildStep(1, 'out', 'n-b', ['r-1']);
  return kit;
}

describe('asking the server about the definition', () => {
  it('sends nothing while the definition is incomplete, then one typed request after the debounce, and shows valid', async () => {
    const kit = await builderWorkspace();
    await openBuilder();
    await chooseStart('n-a');
    await userEvent.click(addStepButton());
    await chooseDirection(1, 'out');
    await afterDebounce();
    expect(kit.validations).toHaveLength(0);
    await chooseArrival(1, 'n-b');
    await toggleType(1, 'r-1');
    expect(screen.getByText('Checking…')).toBeTruthy();
    await afterDebounce();
    expect(kit.validations).toEqual([{ sourceId: 'a', definition: { anchorType: 'n-a', steps: [{ relationshipTypes: ['r-1'], direction: 'out', arrivesAt: 'n-b' }] } }]);
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
  });

  it('sends one request for a burst of changes, and the mask with it when masking is on', async () => {
    const kit = await builderWorkspace();
    act(() => kit.state.setMask(true));
    await settle();
    await openBuilder();
    await chooseStart('n-a');
    await buildStep(1, 'out', 'n-b', ['r-1']);
    await toggleType(1, 'r-2');
    await afterDebounce();
    expect(kit.validations).toHaveLength(1);
    expect(kit.validations[0]?.definition).toMatchObject({ steps: [{ relationshipTypes: ['r-1', 'r-2'] }] });
    expect(kit.validations[0]?.mask).toBe(true);
  });
});

describe('what the server finds wrong', () => {
  it('shows each problem in words next to its step, or the start type, or at the top, and says it is not valid', async () => {
    await oneStep({
      validate: async () =>
        invalid({ path: ['steps', 0, 'relationshipTypes'], code: 'relationship-does-not-join' }, { path: ['anchorType'], code: 'unknown-entity-type' }, { path: ['steps'], code: 'too-many' }),
    });
    await afterDebounce();
    expect(screen.getByText(/^Not valid\./)).toBeTruthy();
    expect(within(stepCard(1)).getByText('This relationship type does not join the types of this step in this direction.')).toBeTruthy();
    const top = screen.getByText('There are more here than a pattern may have.');
    expect(stepCard(1).contains(top)).toBe(false);
    await userEvent.click(screen.getByRole('tab', { name: 'Start' }));
    const start = startSelect().parentElement as HTMLElement;
    expect(within(start).getByText('This type is not in the mapping.')).toBeTruthy();
    expect(start.contains(top)).toBe(false);
  });

  it('shows the answer to the newest definition only', async () => {
    let release: (answer: Answer) => void = () => undefined;
    let call = 0;
    await oneStep({
      validate: () => (++call === 1 ? new Promise<Answer>((resolve) => (release = resolve)) : Promise.resolve<Answer>({ ok: true, value: { status: 'ok' } })),
    });
    await afterDebounce();
    await toggleType(1, 'r-2');
    await afterDebounce();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
    act(() => release(invalid({ path: ['steps', 0], code: 'bad-value' })));
    await settle();
    expect(screen.queryByText(/^Not valid/)).toBeNull();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
  });

  it('clears the result when the definition becomes incomplete', async () => {
    await oneStep();
    await afterDebounce();
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
    await toggleType(1, 'r-1');
    await afterDebounce();
    expect(screen.queryByText(/The mapping can follow this pattern|Not valid|Checking/)).toBeNull();
  });
});

describe('a check that could not be made', () => {
  it.each([
    ['RATE_LIMITED', { retryAfterMs: 12000 }, 'You can try again in 12 s.'],
    ['NOT_FOUND', undefined, 'This was not found. It may have been removed.'],
    ['ACCESS_DENIED', undefined, 'You may not do this on this source.'],
    ['SCHEMA_MISMATCH', undefined, 'The answer was not in the form expected.'],
    ['NETWORK_UNAVAILABLE', undefined, 'The server could not be reached.'],
  ])('says so with the reason and Retry for %s, keeps the choices and never says valid', async (code, details, reason) => {
    await oneStep({ validate: async () => ({ ok: false, failure: code === 'SCHEMA_MISMATCH' || code === 'NETWORK_UNAVAILABLE' ? ({ code } as never) : failure(code, details) }) });
    await afterDebounce();
    expect(within(screen.getByRole('alert')).getByText('The check could not be made.')).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
    expect(screen.queryByText(/The mapping can follow this pattern/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Outgoing' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('asks again on Retry and shows valid when the answer comes', async () => {
    let call = 0;
    const kit = await oneStep({ validate: async () => (++call === 1 ? { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } as never } : { ok: true, value: { status: 'ok' } }) });
    await afterDebounce();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(kit.validations).toHaveLength(2);
    expect(screen.getByText('The mapping can follow this pattern')).toBeTruthy();
  });

  it('drops a check that is on its way when the source changes, and shows nothing of its answer', async () => {
    let signal: AbortSignal | undefined;
    let release: (answer: Answer) => void = () => undefined;
    const kit = await oneStep({
      validate: (_request, aborted) => {
        signal = aborted;
        return new Promise<Answer>((resolve) => (release = resolve));
      },
    });
    await afterDebounce();
    act(() => kit.state.bindSource('b'));
    await settle();
    expect(signal?.aborted).toBe(true);
    act(() => release({ ok: true, value: { status: 'ok' } }));
    await settle();
    expect(screen.queryByText(/The mapping can follow this pattern/)).toBeNull();
  });
});
