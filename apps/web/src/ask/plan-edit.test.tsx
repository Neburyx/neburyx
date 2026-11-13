import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AskPlan } from '@neburyx/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { server } from './ask-kit.js';
import { answer, button, cleanup, drawPlan, EXPIRES, hasButton, heavyResult, ok, PLAN_ID, sharedPlan } from './plan-kit.js';

afterEach(cleanup);

const limit = (): HTMLInputElement => screen.getByRole('textbox', { name: 'Limit' }) as HTMLInputElement;
const NEW_ID = '0192f000-0000-7000-8000-0000000000a2';
const edited = (plan: AskPlan, planId = NEW_ID) => ok({ plan, planId, expiresAt: '2026-11-13T10:30:00.000Z' }) as never;

describe('Edit, when a value is refused', () => {
  it('says what is wrong beside the field and sends nothing for a number out of range', async () => {
    const { edits } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.clear(limit());
    await userEvent.type(limit(), '0');
    await userEvent.click(button('Save'));
    expect(screen.getByText('Limit is a whole number of 1 or more.')).toBeTruthy();
    expect(limit().getAttribute('aria-invalid')).toBe('true');
    expect(edits).toHaveLength(0);
  });

  it.each([
    ['ASK_PLAN_INVALID'],
    ['SOURCE_MISMATCH'],
    ['INVALID_REQUEST'],
  ])('keeps the fields as typed and says the values do not fit, without echoing anything, when the server answers %s', async (code) => {
    const { edits } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.clear(limit());
    await userEvent.type(limit(), '30');
    await userEvent.click(button('Save'));
    await answer(edits[0], server(code) as never);
    expect(screen.getByText("These values don't fit this plan. Check them and save again.")).toBeTruthy();
    expect(limit().value).toBe('30');
    expect(hasButton('Save')).toBe(true);
    expect(button('Save').disabled).toBe(false);
  });

  it.each([
    ['an expired plan', server('CONFLICT', { reason: 'plan-expired' }), 'This plan expired. Ask the question again.'],
    ['a plan that can no longer run', server('CONFLICT', { reason: 'plan-not-runnable' }), 'This plan can no longer be run. Ask the question again.'],
  ])('says %s with Ask again, and changes nothing', async (_name, failure, words) => {
    const { edits } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.click(button('Save'));
    await answer(edits[0], failure as never);
    expect(screen.getByText(words, { selector: '.ask-plan-status' })).toBeTruthy();
    expect(hasButton('Ask again')).toBe(true);
  });
});

describe('Edit, when the save fails for a reason that is not the plan\u2019s', () => {
  it('keeps the form and what was typed, with the words beside it, for a rate limit and for a lost answer, and Save sends the same edit again', async () => {
    const { edits } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.clear(limit());
    await userEvent.type(limit(), '30');
    await userEvent.click(button('Save'));
    await answer(edits[0], { ok: false, failure: { code: 'NETWORK_UNAVAILABLE' } } as never);
    expect(screen.getByText('The change may not have been saved. Try again.')).toBeTruthy();
    expect(limit().value).toBe('30');
    await userEvent.click(button('Save'));
    expect(edits).toHaveLength(2);
    expect(edits[1]?.request).toEqual(edits[0]?.request);
    await answer(edits[1], server('RATE_LIMITED', { retryAfterMs: 2000 }) as never);
    expect(limit().value).toBe('30');
  });
});

describe('Edit, when it passes', () => {
  it('sends the plan, its template and the parameters with the source on the reference, and shows the new plan for review with its own ID', async () => {
    const { edits, runs } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.clear(limit());
    await userEvent.type(limit(), '10');
    await userEvent.click(button('Save'));
    expect(edits[0]?.request).toEqual({ planId: PLAN_ID, templateId: 'shared-attribute', params: { ref: { sourceId: 'demo', entityType: 'widget', stableId: 'w-1' }, attributeType: 'gadget', via: 'HOLDS', window: { days: 30 }, limit: 10 } });
    expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
    await answer(edits[0], edited(sharedPlan({ limit: 10 })));
    expect(screen.getByText('Limit', { selector: 'dt' }).nextElementSibling?.textContent).toBe('10');
    expect(screen.getByText('The plan was changed. Nothing has run.')).toBeTruthy();
    await userEvent.click(button('Run'));
    expect(runs[0]?.request).toEqual({ planId: NEW_ID });
  });

  it('offers no Edit on a heavy stop, so an edit can never carry a continue token; the edited plan is a new plan that has to be run', async () => {
    const { runs } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Run'));
    await answer(runs[0], ok(heavyResult()));
    expect(hasButton('Continue')).toBe(true);
    expect(hasButton('Edit')).toBe(false);
  });

  it('returns to the plan unchanged on Back and on Escape, sending nothing', async () => {
    const { edits } = await drawPlan(sharedPlan(), { profile: true });
    await userEvent.click(button('Edit'));
    await userEvent.click(button('Back'));
    expect(hasButton('Run')).toBe(true);
    await userEvent.click(button('Edit'));
    await userEvent.keyboard('{Escape}');
    expect(hasButton('Run')).toBe(true);
    expect(edits).toHaveLength(0);
  });
});

describe('Edit, for a plan that has nothing to change', () => {
  it.each(['entity', 'degree-preview'])('says there is nothing to change for a plan of %s and offers Ask again', async (templateId) => {
    await drawPlan({ kind: 'plan', templateId, templateVersion: 1, rationale: 'x', params: { ref: { entityType: 'widget', stableId: 'w-1' } } } as never);
    await userEvent.click(button('Edit'));
    expect(screen.getByText(/Nothing to change here/, { selector: '.ask-plan-status' })).toBeTruthy();
    expect(hasButton('Ask again')).toBe(true);
    expect(hasButton('Save')).toBe(false);
  });

  it('never sends a free-form value for a template the form does not know', async () => {
    const { edits } = await drawPlan({ kind: 'plan', templateId: 'future-template', templateVersion: 1, rationale: 'x', params: { ref: { entityType: 'widget', stableId: 'w-1' }, depth: 3 } } as never);
    await userEvent.click(button('Edit'));
    expect(screen.getByText('This plan cannot be edited here. Ask the question again.', { selector: '.ask-plan-status' })).toBeTruthy();
    expect(hasButton('Save')).toBe(false);
    expect(edits).toHaveLength(0);
  });

  it('keeps the expiry of the plan the server gave', async () => {
    await drawPlan();
    expect(EXPIRES).toBe('2026-11-13T10:15:00.000Z');
  });
});
