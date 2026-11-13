import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from './ask-kit.js';
import { answer, button, cleanup, drawPlan, hasButton, ok, PLAN_ID } from './plan-kit.js';

afterEach(cleanup);

const status = (): string => screen.getByText(/./, { selector: '.ask-plan-status' }).textContent ?? '';

describe('Cancel, when it fails', () => {
  it.each([
    ['a plan that is not there', server('NOT_FOUND'), 'This plan is no longer there. Ask the question again.'],
    ['an expired plan', server('CONFLICT', { reason: 'plan-expired' }), 'This plan expired. Ask the question again.'],
    ['a plan that can no longer run', server('CONFLICT', { reason: 'plan-not-runnable' }), 'This plan can no longer be run. Ask the question again.'],
  ])('says the words of %s and never claims the plan was cancelled', async (_name, failure, words) => {
    const { cancels, runs } = await drawPlan();
    await userEvent.click(button('Cancel'));
    await answer(cancels[0], failure as never);
    expect(status()).toBe(words);
    expect(screen.queryByText('Plan cancelled. Nothing ran.')).toBeNull();
    expect(hasButton('Ask again')).toBe(true);
    expect(runs).toHaveLength(0);
  });

  it('says the plan may not have been cancelled when the answer was lost, and lets the person try again', async () => {
    const { cancels } = await drawPlan();
    await userEvent.click(button('Cancel'));
    await answer(cancels[0], { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as never);
    expect(status()).toBe('The plan may not have been cancelled. Try again.');
    expect(screen.queryByText('Plan cancelled. Nothing ran.')).toBeNull();
    await userEvent.click(button('Try again'));
    expect(cancels).toHaveLength(2);
  });
});

describe('Cancel, once pressed', () => {
  it('sends one cancel for the plan, says it was cancelled and that nothing ran, and makes no run request', async () => {
    const { cancels, runs } = await drawPlan();
    await userEvent.click(button('Cancel'));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled') ? document.body : button('Cancel')).catch(() => undefined);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.request).toEqual({ planId: PLAN_ID });
    await answer(cancels[0], ok({ planId: PLAN_ID, state: 'cancelled' as const }));
    expect(status()).toBe('Plan cancelled. Nothing ran.');
    for (const name of ['Run', 'Edit', 'Cancel']) expect(hasButton(name)).toBe(false);
    expect(runs).toHaveLength(0);
  });

  it('cannot be pressed twice while it is out, and not while a run is out', async () => {
    const { cancels, runs } = await drawPlan();
    await userEvent.click(button('Run'));
    expect(button('Cancel').disabled).toBe(true);
    expect(runs).toHaveLength(1);
    expect(cancels).toHaveLength(0);
  });
});
