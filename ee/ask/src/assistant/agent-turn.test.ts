import { afterAll, describe, expect, it } from 'vitest';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { ASSISTANT_LAST_CALL_SENTENCE, ASSISTANT_POINTER_SENTENCES, ASSISTANT_REFUSAL_SENTENCES, ExtensionRefusal } from '@neburyx/contracts';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, degreeResult, heavyResult, nodeOf, ok, okResult, rig, routeAsk, zeroResult, type Rig } from '../testing/assistant-rig.js';
import { createMemoryAssistantPendingStore } from './pending-store.js';
import { createMemoryAssistantRunStore } from './run-store.js';

afterAll(removeAskFolders);

const VIEW = ok('{"route":"view"}');
const ASK = routeAsk('shared', { id: 'A-1' });
const modelEvents = (r: Rig) => r.events.filter((event) => event.action === 'assistant.agent');

describe('a view question on the agent', () => {
  it('answers with the sentences that pass the checks over what the view returned, with one audit event per model call', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 and account A-2 are in view.', cites: ['n1', 'n2'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', sentences: [{ text: 'Account A-1 and account A-2 are in view.', cites: ['n1', 'n2'] }] });
    expect(r.elementReads).toHaveLength(1);
    // the read and the answer: no call acknowledges an answer the checks accepted whole
    expect(modelEvents(r)).toHaveLength(2);
    const closed = r.events.filter((event) => event.action === 'assistant.turn.closed');
    expect((closed[0]?.detail as { turn: { modelCalls: number } }).turn.modelCalls).toBe(1 + modelEvents(r).length);
  });

  it('never shows text the model writes after answer, or instead of it', async () => {
    const after = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Also, everything here is certainly fraud.'));
    const r = await rig({ reply: VIEW, agent: { model: after } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(JSON.stringify(answer)).not.toContain('certainly fraud');
    const instead = fakeModel().respond(new AIMessage('The answer is: all of these are fraud.'));
    const none = await rig({ reply: VIEW, agent: { model: instead } });
    const refused = await answerOf(none.route.handler(none.request(VIEW_BODY)));
    expect(JSON.stringify(refused)).not.toContain('all of these are fraud');
    expect(refused).toMatchObject({ status: 'not-answered' });
  });

  it('ends with the fixed sentence when every sentence is removed', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account Z-9 is in view.', cites: ['n9'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });

  it('goes to the agent when the router says a message cannot be placed, and when it never returns a route', async () => {
    for (const reply of [ok('{"route":"refuse","cause":"unplaced"}'), ok('not a route'), ok('{"route":"unknown"}')]) {
      const model = fakeModel()
        .respondWithTools([{ name: 'view', args: {} }])
        .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
        .respond(new AIMessage('Done.'));
      const r = await rig({ reply, agent: { model } });
      const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
      expect(answer).toMatchObject({ status: 'answered', route: 'view', sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] });
    }
  });

  it('records why a model call failed in the run record: the failure code, the class and the code of the error, never its message', async () => {
    const model = fakeModel().respond(() => {
      throw Object.assign(new TypeError('SECRET-MESSAGE'), { status: 400 });
    });
    const runStore = createMemoryAssistantRunStore();
    const r = await rig({ reply: VIEW, agent: { model }, runStore });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    const failed = runStore.runs.flatMap((run) => run.callEnds).filter((end) => end.status === 'failed');
    expect(failed).toMatchObject([{ failureKind: 'provider-error', errorClass: 'TypeError', errorCode: '400' }]);
    expect(JSON.stringify(runStore.runs)).not.toContain('SECRET-MESSAGE');
    expect(JSON.stringify(r.events)).not.toContain('SECRET-MESSAGE');
  });

  it('shows the answer that stands when the model call that follows it fails, and the failure when no answer stands', async () => {
    const withAnswer = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(() => {
        throw new Error('fetch failed: connection reset');
      });
    const r = await rig({ reply: VIEW, agent: { model: withAnswer } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', route: 'view', sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] });
    const none = fakeModel().respond(() => {
      throw new Error('fetch failed: connection reset');
    });
    const failed = await rig({ reply: VIEW, agent: { model: none } });
    expect(await answerOf(failed.route.handler(failed.request(VIEW_BODY)))).toMatchObject({ status: 'unavailable' });
  });

  it('answers how many there are with the count the degree read states, cited, with its quality', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'The gadget count is 169,756, which is exact.', cites: ['s1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: 'The gadget count is 169,756, which is exact.' }] });
  });

  it('keeps a cited sentence for each part of a two-part count question, one of them saying a count is not yet retrieved, and the instructions tell the model to answer every part with a count as a number', async () => {
    const store = createMemoryAssistantRunStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'The relationships of A-1 are not yet retrieved by type: the read states all types 184,533 (exact).', cites: ['n1', 's1'] }, { text: 'Account A-1 has 169,756 gadget relationships (exact).', cites: ['n1', 's1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }), runStore: store });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: expect.stringContaining('not yet retrieved') }, { text: 'Account A-1 has 169,756 gadget relationships (exact).' }] });
    const instructions = store.runs[0]?.callStarts[1]?.instructionsText ?? '';
    expect(instructions).toContain('answer every part, each in a sentence of its own');
    expect(instructions).toContain('State a count as a number with its quality');
    expect(instructions).toContain('a part is never left out');
    expect(instructions).toContain('not yet retrieved');
    expect(instructions).toContain('cites the elements or the read line it speaks of, and only those; never cite a key only to keep a sentence');
    expect(instructions).toContain('that those lines do not answer is answered by reading that element\'s neighbours with expand or linked-entities before you say it is not shown');
    expect(instructions).toContain('When a sentence says how many, it cites every element it counts in that same sentence.');
  });

  it('keeps a sentence that names the element and states the count when it cites the element and the degree line, and removes it when it cites the line alone', async () => {
    const answered = (cites: string[]) =>
      fakeModel()
        .respondWithTools([{ name: 'view', args: {} }])
        .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
        .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 has 169,756 gadget (exact).', cites }] } }])
        .respond(new AIMessage('Done.'));
    const both = await rig({ reply: VIEW, agent: { model: answered(['n1', 's1']), maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(both.route.handler(both.request(VIEW_BODY)))).toMatchObject({ status: 'answered', sentences: [{ cites: ['n1', 's1'] }] });
    const lineOnly = await rig({ reply: VIEW, agent: { model: answered(['s1']), maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(lineOnly.route.handler(lineOnly.request(VIEW_BODY)))).toMatchObject({ status: 'not-answered' });
  });

  it('gives a sentence that cites only a read line a marker of its own: a citation of the kind read with what the server wrote of that read', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }, { text: 'The degree read states all types 184,533 (exact).', cites: ['s1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['n1'] }, { cites: ['s1'] }] });
    const citations = (answer as { citations: { key: string; kind: string; label?: string; finding?: string }[] }).citations;
    expect(citations.find((citation) => citation.key === 's1')).toMatchObject({ kind: 'read', label: 'degree-preview' });
    expect(citations.find((citation) => citation.key === 's1')?.finding).toContain('all types 184,533 (exact)');
    expect(citations.filter((citation) => citation.kind === 'read')).toHaveLength(1);
  });

  it('removes a count that the degree read does not state', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'The gadget count is 170,000, which is exact.', cites: ['s1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'not-answered' });
  });

  it('shows the fixed sentence of a pointer the model names, and still removes the model\'s own uncited sentence', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Use the Expand action to add them.', cites: [] }, { text: 'Account A-1 is in view.', cites: ['n1'] }], pointer: 'canvas-expand' } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', pointer: ASSISTANT_POINTER_SENTENCES['canvas-expand'] });
    expect(JSON.stringify(answer)).not.toContain('Use the Expand action');
    const none = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }], pointer: 'anything-else' } }])
      .respond(new AIMessage('Done.'));
    const other = await rig({ reply: VIEW, agent: { model: none } });
    expect(JSON.stringify(await answerOf(other.route.handler(other.request(VIEW_BODY))))).not.toContain('anything-else');
  });

  it('does not mark a limit on an answer given on the last call the turn may make, because the limit cut nothing short', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 3 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 is in view.' }] });
    expect(answer).not.toHaveProperty('stoppedAt');
    expect(answer).toMatchObject({ lastCallNote: ASSISTANT_LAST_CALL_SENTENCE });
  });

  it('says nothing of the last call when the answer that stands was written earlier and the last answer kept nothing', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account Z-9 is in view.', cites: ['n9'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 4 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 is in view.' }] });
    expect(answer).not.toHaveProperty('lastCallNote');
  });

  it('carries no note on an answer given while reads were still allowed', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 6 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered' });
    expect(answer).not.toHaveProperty('lastCallNote');
    expect(answer).not.toHaveProperty('stoppedAt');
  });

  it('makes no call after an answer the checks accepted whole, and still gives the model its one chance to answer again when a sentence was removed', async () => {
    const whole = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(() => {
        throw new Error('a call after an accepted answer');
      });
    const r = await rig({ reply: VIEW, agent: { model: whole } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 is in view.' }] });
    expect(modelEvents(r).filter((event) => event.result === 'failed')).toHaveLength(0);
    expect(modelEvents(r)).toHaveLength(2);
    const removed = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }, { text: 'Account Z-9 is in view.', cites: ['n9'] }] } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(() => {
        throw new Error('a call after an accepted answer');
      });
    const again = await rig({ reply: VIEW, agent: { model: removed, maxCalls: 8 } });
    expect(await answerOf(again.route.handler(again.request(VIEW_BODY)))).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 is in view.' }] });
    expect(modelEvents(again)).toHaveLength(3);
  });

  it('is not called for a verdict the router refuses', async () => {
    const model = fakeModel().respond(new AIMessage('never asked'));
    const r = await rig({ reply: ok('{"route":"refuse","cause":"verdict"}'), agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict });
    expect(modelEvents(r)).toHaveLength(0);
  });

  it('keeps the last answer that left a sentence, and does not replace it with a later one that left none', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account Z-9 is in view.', cites: ['n9'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 is in view.' }] });
  });

  it('suppresses the whole draft when a sentence holds verdict wording, even if the others pass', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }, { text: 'Account A-2 is guilty of fraud.', cites: ['n2'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });

  it('answers over what was read when the steps limit is reached, carrying the limit it stopped at', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, loopSteps: 1 });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'steps' });
    expect(r.elementReads).toHaveLength(1);
  });

  it('ends with the fixed sentence for the calls limit when the model never answers', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'view', args: {} }]);
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 3 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'limit', limit: 'calls' });
  });

  it('ends as unavailable, with the reads made, when the model fails mid-turn, and records the failed call', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respond(Object.assign(new Error('overloaded'), { status: 503 }));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'unavailable', kind: 'service' });
    expect(modelEvents(r).map((event) => event.result)).toEqual(['success', 'failed']);
  });

  it('stops and shows nothing when the request is cancelled', async () => {
    const controller = new AbortController();
    const model = fakeModel().respond(() => { controller.abort(); return new AIMessage('late'); });
    const r = await rig({ reply: VIEW, agent: { model } });
    await expect(r.route.handler(r.request(VIEW_BODY, { signal: controller.signal }))).rejects.toThrow();
  });

});

describe('a heavy read of the agent waits for the analyst', () => {
  const heavyFor = 'A-9';
  const runOf = (continuing: boolean, asked: unknown) => (JSON.stringify(asked).includes(heavyFor) && !continuing ? { status: 'ok' as const, result: heavyResult() } : { status: 'ok' as const, result: okResult() });
  const script = () =>
    fakeModel()
      .respondWithTools([{ name: 'byId', args: { id: 'A-2' } }])
      .respondWithTools([{ name: 'byId', args: { id: heavyFor } }, { name: 'byId', args: { id: 'A-3' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] } }])
      .respond(new AIMessage('Done.'));

  async function waitingTurn() {
    const pending = createMemoryAssistantPendingStore();
    const r = await rig({ reply: ASK, agent: { model: script() }, pending, run: runOf });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 200)}`);
    return { r, first };
  }
  const decide = (r: Rig, first: Extract<Awaited<ReturnType<typeof answerOf>>, { status: 'confirmation' }>, decision: 'confirm' | 'skip' | 'cancel') =>
    answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision } })));

  it('reads nothing of the heavy step, runs no later call of the same response, and waits', async () => {
    const { r, first } = await waitingTurn();
    expect(first.step).toMatchObject({ tool: 'byId', subject: 'A-9' });
    expect(r.runs.filter((run) => JSON.stringify(run.asked).includes('A-3'))).toHaveLength(0);
    expect(r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(0);
  });

  it('reads the earlier steps again, then the confirmed step, and goes on to the answer', async () => {
    const { r, first } = await waitingTurn();
    const answer = await decide(r, first, 'confirm');
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ text: 'Account A-1 and account A-2 are listed.' }] });
    expect(r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(1);
  });

  it('leaves the step out on skip and reads nothing on cancel', async () => {
    const skipped = await waitingTurn();
    const afterSkip = await decide(skipped.r, skipped.first, 'skip');
    expect(afterSkip.status).toBe('answered');
    expect(skipped.r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(0);
    const cancelled = await waitingTurn();
    const before = cancelled.r.runs.length;
    await decide(cancelled.r, cancelled.first, 'cancel');
    expect(cancelled.r.runs).toHaveLength(before);
  });
});

describe('the application tools of the agent', () => {
  it('reads the typology as a tool and lets the answer cite its lines', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'typology', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Rapid movement of funds is one of the shapes listed.', cites: ['t1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, typology: ['Rapid movement of funds', 'Structuring'] });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['t1'] }], reads: [{ tool: 'typology', kind: 'typology', read: true }] });
  });

  it('does not offer a tool the turn cannot use, and refuses a call to it before anything runs', async () => {
    const model = fakeModel().respondWithTools([{ name: 'ai-summary', args: {} }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).not.toBe('answered');
    expect(r.elementReads).toHaveLength(0);
  });
});

describe('the table form of the agent', () => {
  const TABLE = ok('{"route":"view","form":"table"}');
  it('keeps the rows that pass the row checks, and drops a row that cites nothing the reads returned', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }, { cells: ['Account Z-9'], cites: ['n9'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', table: { columns: ['Element'], rows: [{ cites: ['n1'] }], droppedRows: 1 } });
  });

  it('asks again for a table that is not in the shape, and shows nothing of it', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { columns: ['Element'], rows: [{ cells: ['a', 'b'], cites: ['n1'] }] } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });
});

describe('what the model may ask the agent to run', () => {
  const asks = (name: string, args: Record<string, unknown>) => fakeModel().respondWithTools([{ name, args }]).respond(new AIMessage('Done.'));

  it.each([
    ['a tool that is not offered', 'dropEverything', {}],
    ['a value the tool does not take', 'byId', { id: 'A-2', extra: 'x' }],
    ['an empty value', 'byId', { id: '' }],
    ['a value of another type', 'byId', { id: 7 }],
  ])('runs nothing for %s', async (_what, name, args) => {
    const r = await rig({ reply: ASK, agent: { model: asks(name, args) } });
    const before = r.runs.length;
    await answerOf(r.route.handler(r.request()));
    expect(r.runs).toHaveLength(before);
  });

  it('passes a value to the gate only as a parameter of an offered tool', async () => {
    const r = await rig({ reply: ASK, agent: { model: asks('byId', { id: 'A-2" OR 1=1 //' }) } });
    await answerOf(r.route.handler(r.request()));
    expect(r.runs.map((run) => JSON.stringify(run.asked))).toEqual([expect.stringContaining('A-2\\" OR 1=1 //')]);
  });
});

describe('a failure of the gate during an agent read', () => {
  it('ends the turn as the gate gave it, never as text to the model', async () => {
    const model = fakeModel().respondWithTools([{ name: 'byId', args: { id: 'A-2' } }]).respond(new AIMessage('never asked'));
    const r = await rig({ reply: ASK, agent: { model }, runThrows: new ExtensionRefusal({ code: 'SOURCE_UNAVAILABLE', reason: 'unreachable' }) });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'unavailable', kind: 'source-unavailable', readStarted: true });
  });
});

describe('the seams of the agent turn', () => {
  it('tells the model what the removal feedback says, and lets a caller replace it', async () => {
    const seen: string[] = [];
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account Z-9 is in view.', cites: ['n9'] }] } }])
      .respond((messages) => {
        seen.push(messages.map((message) => JSON.stringify(message.content)).join('\n'));
        return new AIMessage('Done.');
      });
    const r = await rig({ reply: VIEW, agent: { model, removalFeedback: ({ removed }) => `REPLACED FEEDBACK ${removed}` } });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(seen[0]).toContain('REPLACED FEEDBACK 1');
  });

  it('answers a message the router could not place, from the start, through the agent', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('not a route at all'), agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', sentences: [{ cites: ['n1'] }] });
  });

  it('tells a streamed turn each read as a step and that it is answering, and no model text', async () => {
    const emitted: { phase: string }[] = [];
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    await answerOf(r.route.handler(r.request(VIEW_BODY, { emit: (_name: string, data: unknown) => void emitted.push(data as { phase: string }) })));
    const phases = emitted.map((event) => event.phase);
    expect(phases).toContain('reading-view');
    expect(phases).toContain('read-done');
    expect(phases).toContain('answering');
    expect(JSON.stringify(emitted)).not.toContain('Done.');
  });
});

describe('the limits of the agent turn', () => {
  const answerOnce = () =>
    fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));

  it('answers over what was read when the rows limit is reached, carrying the limit it stopped at', async () => {
    const r = await rig({ reply: VIEW, agent: { model: answerOnce() }, loopRows: 1 });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'rows' });
    expect(r.elementReads).toHaveLength(1);
  });

  it('ends with the fixed sentence for the time limit when the deadline passes while a read is in flight', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respond(new AIMessage('never asked'));
    const r = await rig({ reply: VIEW, agent: { model }, viewReadHangs: true });
    const turn = answerOf(r.route.handler(r.request(VIEW_BODY)));
    await new Promise((resolve) => setTimeout(resolve, 50));
    r.expire();
    expect(await turn).toMatchObject({ status: 'limit', limit: 'time' });
  });
});

describe('what an agent answer may say beyond the elements', () => {
  it('lets a sentence state that a read found nothing by citing the line of that read, and keeps that line out of the citations', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'byId', args: { id: 'A-2' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'The read of byId found nothing.', cites: ['s1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ASK, agent: { model }, run: () => ({ status: 'ok', result: zeroResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    if (answer.status !== 'answered' || !('sentences' in answer)) throw new Error(`not a sentence answer: ${JSON.stringify(answer).slice(0, 200)}`);
    expect(answer.sentences[0]?.cites).toEqual(['s1']);
    // a cite to a read line is no element: it carries a citation of the kind read, which the card draws as a marker, and no element citation
    expect(answer.citations.filter((citation) => citation.key === 's1').map((citation) => citation.kind)).toEqual(['read']);
  });

  it('shows the fixed sentence for a type the mapping does not describe beside a table and beside sentences', async () => {
    const types = ['widget'];
    const table = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }], noDescription: ['widget'] } }])
      .respond(new AIMessage('Done.'));
    const a = await rig({ reply: ok('{"route":"view","types":["widget"],"form":"table"}'), agent: { model: table }, types });
    const tabled = await answerOf(a.route.handler(a.request(VIEW_BODY)));
    expect(tabled).toMatchObject({ status: 'answered', route: 'view', noDescription: 'The mapping has no description for widget, so I cannot say what it means.' });
    const sentences = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }], noDescription: ['widget'] } }])
      .respond(new AIMessage('Done.'));
    const b = await rig({ reply: ok('{"route":"view","types":["widget"]}'), agent: { model: sentences }, types });
    expect(await answerOf(b.route.handler(b.request(VIEW_BODY)))).toMatchObject({ status: 'answered', sentences: [{ cites: ['n1'] }], noDescription: expect.stringContaining('no description') });
  });

  it('says in the closing event that property values were sent when a read carried them', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, viewNodes: [nodeOf('A-1', 'Account A-1')] });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const closed = r.events.find((event) => event.action === 'assistant.turn.closed');
    expect((closed?.detail as { turn: { propertyValuesSent?: boolean } }).turn.propertyValuesSent).toBe(false);
  });

  it('titles a table of the elements it reads and counts them, in the server\'s words', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { columns: ['Element'], rows: [{ cells: ['Account A-1'], cites: ['n1'] }, { cells: ['Account A-2'], cites: ['n2'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', table: { title: expect.stringMatching(/2 rows/) }, coverage: { summary: expect.stringMatching(/2 of 2/) } });
  });
});

describe('a decision on a confirmation the agent turn waits for', () => {
  const heavyAsk = routeAsk('shared', { id: 'A-9' });
  const waiting = async () => {
    const pending = createMemoryAssistantPendingStore();
    const model = fakeModel().respondWithTools([{ name: 'shared', args: { id: 'A-9' } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: heavyAsk, agent: { model }, pending, run: (continuing: boolean) => ({ status: 'ok' as const, result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 160)}`);
    return { r, first };
  };
  const decide = (r: Rig, first: Extract<Awaited<ReturnType<typeof answerOf>>, { status: 'confirmation' }>, plan: string, decision: 'confirm' | 'skip' | 'cancel' = 'confirm') =>
    answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan, decision } })));

  it('refuses a plan that was used already, with nothing read', async () => {
    const { r, first } = await waiting();
    const before = r.runs.length;
    await decide(r, first, first.plan, 'cancel');
    expect(await decide(r, first, first.plan)).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs).toHaveLength(before);
  });
});

describe('a first read that waits for the analyst, with one step allowed', () => {
  it('is read after Confirm', async () => {
    const pending = createMemoryAssistantPendingStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'shared', args: { id: 'A-9' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: routeAsk('shared', { id: 'A-9' }), agent: { model }, pending, loopSteps: 1, run: (continuing: boolean) => ({ status: 'ok' as const, result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error('not waiting');
    const answer = await answerOf(r.route.handler(r.request({ ...BODY, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } })));
    expect(answer).toMatchObject({ status: 'answered' });
    expect(r.runs.filter((run) => (run.options as { continue?: boolean } | undefined)?.continue === true)).toHaveLength(1);
  });
});

describe('the follow-ups of an agent answer on the ask route', () => {
  const INTENTS = {
    shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: 'widget', stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } },
    widgetById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: 'widget', stableId: '$id' } } },
  };

  it('carries the follow-ups Ask\'s own answer to the read has, and none for a view question', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'shared', args: { id: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 and account A-2 are listed.', cites: ['r1', 'r2'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), agent: { model }, intents: INTENTS });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', sentences: expect.anything(), followUps: expect.arrayContaining([expect.objectContaining({ choice: expect.objectContaining({ intent: 'widgetById' }) })]) });
    const viewModel = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const v = await rig({ reply: VIEW, agent: { model: viewModel }, intents: INTENTS });
    expect(await answerOf(v.route.handler(v.request(VIEW_BODY)))).not.toHaveProperty('followUps');
  });
});

describe('the records and the audit of an agent turn', () => {
  it('writes one stored call for each agent model call, and every agent audit event names the run they belong to', async () => {
    const store = createMemoryAssistantRunStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, runStore: store });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const [run] = store.runs;
    const agentEvents = modelEvents(r);
    expect(agentEvents).toHaveLength(2);
    for (const event of agentEvents) expect((event.detail as { ai: { runId?: string } }).ai.runId).toBe(run?.id);
    expect(run?.callStarts).toHaveLength(1 + agentEvents.length);
  });

  it('ends the turn as AUDIT_UNAVAILABLE, with no call made to the model, when the audit event cannot be built', async () => {
    let received = 0;
    const model = fakeModel().respond(() => {
      received += 1;
      return new AIMessage('never asked');
    });
    const r = await rig({ reply: VIEW, agent: { model, promptId: 'not a valid prompt id !' } });
    await expect(r.route.handler(r.request(VIEW_BODY))).rejects.toMatchObject({ code: 'AUDIT_UNAVAILABLE' });
    expect(received).toBe(0);
  });
});

describe('the input limit of the agent turn', () => {
  it('ends with the fixed sentence of the limit, and makes no model call, when what the turn would send does not fit', async () => {
    let received = 0;
    const model = fakeModel().respond(() => {
      received += 1;
      return new AIMessage('never asked');
    });
    const r = await rig({ reply: VIEW, agent: { model, maxInputTokens: 1 } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'limit', limit: 'input' });
    expect(received).toBe(0);
    expect(modelEvents(r)).toHaveLength(0);
  });

  it('answers from the reads that fit, with the limit shown under the answer, when the newest read made the next request too large; and stops as before when not even the first read fits', async () => {
    const scripted = () =>
      fakeModel()
        .respondWithTools([{ name: 'view', args: {} }])
        .respondWithTools([{ name: 'degree-preview', args: { entityType: 'widget', stableId: 'A-1' } }])
        .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
        .respond(new AIMessage('Done.'));
    const fits = await rig({ reply: VIEW, agent: { model: scripted(), maxCalls: 8, maxInputTokens: 6_000 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(fits.route.handler(fits.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'input', sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }], reads: [{ tool: 'view' }] });
    expect(JSON.stringify(answer)).not.toContain('degree-preview');
    const none = await rig({ reply: VIEW, agent: { model: scripted(), maxCalls: 8, maxInputTokens: 3_000 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(none.route.handler(none.request(VIEW_BODY)))).toMatchObject({ status: 'limit', limit: 'input' });
  });

  it('ends with the fixed sentence of the limit, and makes no model call, when the request the framework assembles does not fit though the turn\'s own text does', async () => {
    let received = 0;
    const model = fakeModel().respond(() => {
      received += 1;
      return new AIMessage('never asked');
    });
    const r = await rig({ reply: VIEW, agent: { model, maxInputTokens: 1_000 } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'limit', limit: 'input' });
    expect(received).toBe(0);
    expect(modelEvents(r)).toHaveLength(0);
  });
});

describe('a model that repeats a read without progress', () => {
  it('reads no more than the steps allow and ends at the first limit that applies', async () => {
    const model = fakeModel();
    for (let call = 0; call < 20; call += 1) model.respondWithTools([{ name: 'view', args: {} }]);
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 6 }, loopSteps: 2 });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('limit');
    expect(r.elementReads.length).toBeLessThanOrEqual(2);
  });
});

describe('a decision on a confirmation, beyond a plan used already', () => {
  const heavyAsk = routeAsk('shared', { id: 'A-9' });
  const waiting = async () => {
    const pending = createMemoryAssistantPendingStore();
    const model = fakeModel().respondWithTools([{ name: 'shared', args: { id: 'A-9' } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: heavyAsk, agent: { model }, pending, run: (continuing: boolean) => ({ status: 'ok' as const, result: continuing ? okResult() : heavyResult() }) });
    const first = await answerOf(r.route.handler(r.request()));
    if (first.status !== 'confirmation') throw new Error(`not waiting: ${JSON.stringify(first).slice(0, 160)}`);
    return { r, first };
  };
  const decide = (r: Rig, first: Extract<Awaited<ReturnType<typeof answerOf>>, { status: 'confirmation' }>, over: Record<string, unknown> = {}, principalId?: string) =>
    answerOf(r.route.handler(r.request({ ...BODY, ...over, confirmation: { pendingId: first.pendingId, plan: first.plan, decision: 'confirm' } }, principalId === undefined ? {} : { principalId })));

  it.each([
    ['one sent for another message', { message: 'something else' }, undefined],
    ['one sent by another person', {}, 'p-2'],
  ])('refuses %s, with nothing read', async (_name, over, principalId) => {
    const { r, first } = await waiting();
    const before = r.runs.length;
    expect(await decide(r, first, over, principalId)).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs).toHaveLength(before);
  });

  it('refuses one that has expired, with nothing read', async () => {
    const { r, first } = await waiting();
    const before = r.runs.length;
    r.clock.now += 24 * 60 * 60 * 1000;
    expect(await decide(r, first)).toMatchObject({ status: 'confirmation-invalid' });
    expect(r.runs).toHaveLength(before);
  });
});

describe('a question about what a type means that names no type the mapping has', () => {
  it('goes to the agent as a question for the view', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { sentences: [{ text: 'Account A-1 is in view.', cites: ['n1'] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('{"route":"meaning","types":["nonexistent"]}'), agent: { model }, types: ['widget'] });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', route: 'view', sentences: [{ cites: ['n1'] }] });
  });
});
