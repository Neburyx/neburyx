import { describe, expect, it } from 'vitest';
import { assertReach, baselineRequest, leakyBuilder, leaksIn, runRig, widgetRef, type TypedToken } from './testing/leakage-rig.js';

const KNOWN = { 'Acme Corp': [widgetRef('W-100')], 'W-001': [widgetRef('W-001')] };

describe('the leakage rig', () => {
  it('runs a typed question through the real path and returns the one request the provider received, with a placeholder where the name was', async () => {
    const run = await runRig('which are the same as Acme Corp?', { known: KNOWN });
    expect(run.refusal).toBeUndefined();
    expect(run.answers).toHaveLength(2);
    expect(run.requests).toHaveLength(1);
    expect(JSON.stringify(run.requests[0])).toContain('‹widget#1›');
    expect(JSON.stringify(run.requests[0])).not.toContain('Acme');
    assertReach(run, true);
  });

  it('finds no typed token in the request the real builder makes', async () => {
    const run = await runRig('which are the same as Acme Corp?', { known: KNOWN });
    const tokens: TypedToken[] = [{ kind: 'name', text: 'Acme Corp' }];
    expect(leaksIn(run.requests, tokens, await baselineRequest())).toEqual([]);
  });

  it('finds the typed name in the request a leaky builder makes, and says what kind leaked and never the text', async () => {
    const message = 'which are the same as Acme Corp?';
    const run = await runRig(message, { known: KNOWN, wrapBuilder: leakyBuilder(message) });
    const leaks = leaksIn(run.requests, [{ kind: 'name', text: 'Acme Corp' }], await baselineRequest());
    expect(leaks.length).toBeGreaterThan(0);
    expect(leaks.join('\n')).toContain('name');
    expect(leaks.join('\n')).not.toContain('Acme');
  });

  it('ends before the model for a blocked question, and a run expected to reach the model fails when none was made', async () => {
    const run = await runRig('which are the same as 12345', { known: KNOWN });
    expect(run.requests).toEqual([]);
    expect(run.answers[0]).toHaveProperty('blocked');
    assertReach(run, false);
    expect(() => assertReach(run, true)).toThrow(/no request was made/);
    const reached = await runRig('which are the same as Acme Corp?', { known: KNOWN });
    expect(() => assertReach(reached, false)).toThrow(/expected not to reach/);
  });

  it('ends before the model for an ambiguous mention, which the route answers as a clarification, and a run expected to reach the model fails', async () => {
    const run = await runRig('which are the same as Acme Corp?', { known: { 'Acme Corp': [widgetRef('W-100'), widgetRef('W-200')] } });
    expect(run.answers[0]).toHaveProperty('clarification');
    expect(run.requests).toEqual([]);
    assertReach(run, false);
    expect(() => assertReach(run, true)).toThrow(/no request was made/);
  });

  it('ends before the model for a route refusal, with the refusal kept', async () => {
    const run = await runRig('which are the same as ‹widget#1›');
    expect(run.refusal).toBeDefined();
    expect(run.requests).toEqual([]);
    assertReach(run, false);
  });
});

describe('the checker', () => {
  const baseline = 'catalog vocabulary widget the quick request #1 ‹widget#1›';
  const request = (text: string) => [{ promptId: 'ask.plan' as const, parameters: { question: text } }];
  const leak = (text: string, token: TypedToken) => leaksIn(request(text), [token], baseline);

  it('finds an email by its whole, its local part and its domain, ignoring case', () => {
    expect(leak('write to ZORVATH@Example.Test', { kind: 'email', text: 'zorvath@example.test' }).length).toBeGreaterThan(0);
    expect(leak('mentions zorvath alone', { kind: 'email', text: 'zorvath@example.test' })).toEqual(['email local part of a email token in request 1']);
    expect(leak('on example.test', { kind: 'email', text: 'zorvath@example.test' }).join()).toContain('email domain');
  });

  it('finds each word of a name', () => {
    expect(leak('about Zorvath only', { kind: 'name', text: 'Mira Zorvath' }).join()).toContain('name word');
  });

  it('finds a run of four digits or more inside an ID, and does not look for a run of three', () => {
    expect(leak('ref 123456 here', { kind: 'id', text: 'AB-123456' }).join()).toContain('id digits');
    expect(leak('ref 123 here', { kind: 'number', text: '123' })).toEqual([]);
  });

  it('matches on word boundaries only', () => {
    expect(leak('the Zorvathian road', { kind: 'name', text: 'Zorvath' })).toEqual([]);
  });

  it('refuses a token whose part is in the baseline, so a leak report is always real', () => {
    expect(() => leak('anything', { kind: 'name', text: 'The Widget' })).toThrow(/baseline/);
  });

  it('never prints the text of a token in its messages', () => {
    const messages = [...leak('Zorvath wrote', { kind: 'name', text: 'Zorvath' })];
    try {
      leaksIn(request('x'), [{ kind: 'name', text: 'widget' }], baseline);
    } catch (error) {
      messages.push(String(error));
    }
    expect(messages.join('\n')).not.toMatch(/Zorvath|widget'/);
  });
});
