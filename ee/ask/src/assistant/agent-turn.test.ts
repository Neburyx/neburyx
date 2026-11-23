import { afterAll, describe, expect, it, vi } from 'vitest';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { ASSISTANT_LAST_CALL_SENTENCE, ASSISTANT_POINTER_SENTENCES, ASSISTANT_REFUSAL_SENTENCES, ExtensionRefusal, askRunResultSchema, sentencesOfBlocks, type AskRunResult, type AssistantBlocks } from '@neburyx/contracts';
import { removalNoteOf } from '@neburyx/ee-ai-runtime';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, answerOf, degreeResult, expandEarlierResult, expandResult, heavyResult, lowerBoundResult, nodeOf, ok, okResult, rig, routeAsk, zeroResult, V, type Rig } from '../testing/assistant-rig.js';
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are in view.`, cites: ['n1', 'n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are in view.`, cites: ['n1', 'n2'] }] }] });
    expect(r.elementReads).toHaveLength(1);
    // the read and the answer: no call acknowledges an answer the checks accepted whole
    expect(modelEvents(r)).toHaveLength(2);
    const closed = r.events.filter((event) => event.action === 'assistant.turn.closed');
    expect((closed[0]?.detail as { turn: { modelCalls: number } }).turn.modelCalls).toBe(1 + modelEvents(r).length);
  });

  it('never shows text the model writes after answer, or instead of it', async () => {
    const after = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} Z-9 is in view.`, cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });

  it('goes to the agent when the router says a message cannot be placed, and when it never returns a route', async () => {
    for (const reply of [ok('{"route":"refuse","cause":"unplaced"}'), ok('not a route'), ok('{"route":"unknown"}')]) {
      const model = fakeModel()
        .respondWithTools([{ name: 'view', args: {} }])
        .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
        .respond(new AIMessage('Done.'));
      const r = await rig({ reply, agent: { model } });
      const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
      expect(answer).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] });
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(() => {
        throw new Error('fetch failed: connection reset');
      });
    const r = await rig({ reply: VIEW, agent: { model: withAnswer } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] });
    const none = fakeModel().respond(() => {
      throw new Error('fetch failed: connection reset');
    });
    const failed = await rig({ reply: VIEW, agent: { model: none } });
    expect(await answerOf(failed.route.handler(failed.request(VIEW_BODY)))).toMatchObject({ status: 'unavailable' });
  });

  it('answers how many there are with the count the degree read states, cited, with its quality', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `The ${V.other} count is 169,756, which is exact.`, cites: ['s1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `The ${V.other} count is 169,756, which is exact.` }] }] });
  });

  it('keeps a cited sentence for each part of a two-part count question, one of them saying a count is not yet retrieved, and the instructions tell the model to answer every part with a count as a number', async () => {
    const store = createMemoryAssistantRunStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'The relationships of A-1 are not yet retrieved by type: the read states all types 184,533 (exact).', cites: ['n1', 's1'] }, { text: `${V.title} A-1 has 169,756 ${V.other} relationships (exact).`, cites: ['n1', 's1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }), runStore: store });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: expect.stringContaining('not yet retrieved') }, { text: `${V.title} A-1 has 169,756 ${V.other} relationships (exact).` }] }] });
    const instructions = store.runs[0]?.callStarts[1]?.instructionsText ?? '';
    expect(instructions).toContain('answer every part, each in a sentence of its own');
    expect(instructions).toContain('State a count as a number with its quality');
    expect(instructions).toContain('a part is never left out');
    expect(instructions).toContain('not yet retrieved');
    expect(instructions).toContain('cites the elements or the read line it speaks of, and only those.');
    expect(instructions).toContain('Never cite a key only to keep a sentence');
    expect(instructions).toContain('that those lines do not answer is answered by reading that element\'s neighbours with expand or linked-entities before you say it is not shown');
    expect(instructions).toContain('When a sentence says how many, it cites every element it counts in that same sentence.');
  });

  it('gives the model the coverage of the view as a line it can cite, and keeps a sentence that says what the view does not hold when it cites that line', async () => {
    const store = createMemoryAssistantRunStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'No relationship is shown in the view.', cites: ['c1'] }, { text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, runStore: store });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: 'No relationship is shown in the view.', cites: ['c1'] }, { cites: ['n1'] }] }] });
    const sent = (store.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(sent).toMatch(/c1: view coverage: 2 entities shown \(2 [^)]+\) · 0 relationships shown · /u);
    // the sentence that cites only the line gets a marker of its own, written by the server
    expect(answer).toMatchObject({ citations: expect.arrayContaining([expect.objectContaining({ key: 'c1', kind: 'read', label: 'View coverage', finding: expect.stringContaining('0 relationships shown') })]) });
    expect(sent).toMatch(new RegExp(`c1: view coverage: 2 entities shown \\(2 ${V.anchor}\\)`, 'u'));
  });

  it('keeps no sentence that cites a key of no line: c1 is not offered without a view', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'No relationship is shown in the view.', cites: ['c1'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'No relationship is shown in the view.', cites: ['c1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(r.route.handler(r.request({ ...BODY, viewElementKeys: [] })));
    expect(JSON.stringify(answer)).not.toContain('No relationship is shown in the view.');
  });

  it('tells the model the rules the recorded misses broke: absence cites the coverage line, all and each and the latest cite every element, no link is implied, and a half answer takes the second step', async () => {
    const store = createMemoryAssistantRunStore();
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, runStore: store });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const instructions = store.runs[0]?.callStarts[1]?.instructionsText ?? '';
    expect(instructions).toContain('cites the line c1, the coverage of the view');
    expect(instructions).toContain('a sentence about what a read did not return cites that read\'s own line, and states only what that line says');
    expect(instructions).toContain('take the second step: read the neighbours of that element (expand or linked-entities) before you say the rest is not shown, within the steps allowed');
    expect(instructions).toContain('The line c1 never replaces a read');
    expect(instructions).toContain('whether several elements share something at their other end');
    expect(instructions).toContain('read a bounded sample within the steps (the neighbours of up to three elements, picked by a rule you state, such as the largest or the first listed; for example shared-attribute from one of them');
    expect(instructions).toContain('answer only for that sample: name the elements you read and state what each read returned in a sentence of its own, copying its figure, label and quality, and citing its read line');
    expect(instructions).toContain('one read is anchored on one element and shows what that element has in common with others, not between every pair of the sample');
    expect(instructions).toContain('the other elements were not read: one read each, more than this turn allows');
    expect(instructions).toContain('however it is worded');
    expect(instructions).toContain('never generalise from the sample to the rest');
    expect(instructions).toContain('that the Relationships lines do not answer is answered by reading its neighbours');
    expect(instructions).toContain('a sentence that the view shows no relationship is no answer to it');
    expect(instructions).toContain('find that element in the lines, then take the second step');
    expect(instructions).toContain('exactly as that line writes it, with its label');
    expect(instructions).toContain('or that compares (the latest, the largest, the most), cites every element it speaks of in that same sentence, as a count does');
    expect(instructions).toContain('A sentence that ranks (the largest, smallest, earliest or latest value of a property, or the most or the fewest of a named property) names the property once, makes one ranking assertion, cites every element of that type it ranks over, and writes a compound ranking as separate sentences.');
    expect(instructions).toContain('Name a link between two elements only when a relationship line you cite holds it');
  });

  it('shows the corrected sentence the model sends again after a check removed it, together with the kept one, and the feedback told it to mend and send every sentence again', async () => {
    const store = createMemoryAssistantRunStore();
    const kept = { text: `${V.title} A-1 is in view.`, cites: ['n1'] };
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [kept, { text: `${V.title} A-2 has 7311 rows.`, cites: ['n2'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [kept, { text: `${V.title} A-2 is in view too.`, cites: ['n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, runStore: store });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: kept.text }, { text: `${V.title} A-2 is in view too.` }] }] });
    const told = (store.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(told).toContain('Your next answer replaces this one if any of its sentences is kept: call answer again with every sentence you want shown');
    expect(told).toContain('copy a figure as the line writes it, with its label');
    expect(told).toContain('Leave a sentence out when no line holds its figure, name or comparison, or when it states a conclusion; never add a cite only to keep it.');
    expect(told).not.toContain('left out, not reworded');
  });

  it('tells the model that a sentence removed for verdict wording is left out, and a table that the whole table is sent again with the removed rows corrected', async () => {
    const verdictModel = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }, { text: `${V.title} A-2 is guilty of fraud.`, cites: ['n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const storeA = createMemoryAssistantRunStore();
    const a = await rig({ reply: VIEW, agent: { model: verdictModel, maxCalls: 8 }, runStore: storeA });
    await answerOf(a.route.handler(a.request(VIEW_BODY)));
    expect((storeA.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n')).toContain('A sentence removed for verdict wording is left out, not reworded.');
    const tableModel = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} Z-9`], cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const storeB = createMemoryAssistantRunStore();
    const b = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model: tableModel, maxCalls: 8 }, runStore: storeB });
    await answerOf(b.route.handler(b.request(VIEW_BODY)));
    const told = (storeB.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(told).toContain('call answer again with the whole table, the kept rows and each removed row corrected as its reason says');
    expect(told).not.toContain('every sentence you want shown');
  });

  it('tells the model of an answer with sentences and a table, one row removed, to send every block again, and shows both blocks of the answer that keeps the table', async () => {
    const sentence = { kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] };
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [sentence, { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} Z-9`], cites: ['n9'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [sentence, { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} A-2`], cites: ['n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const store = createMemoryAssistantRunStore();
    const r = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model, maxCalls: 8 }, runStore: store });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const told = (store.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(told).toContain('Checked: 1 sentence and 1 row kept, 1 removed.');
    expect(told).toContain('Your next answer replaces this whole answer if any of its sentences or rows is kept: call answer again with every block you want shown, the sentences and the table');
    expect(told).not.toContain('every sentence you want shown');
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences' }, { kind: 'table', table: { rows: [{ cells: [`${V.title} A-1`] }, { cells: [`${V.title} A-2`] }] } }] });
  });

  it('says that a sentence or a row removed for verdict wording is left out when the answer holds both kinds of block', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is guilty of fraud.`, cites: ['n1'] }] }, { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const store = createMemoryAssistantRunStore();
    const r = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model, maxCalls: 8 }, runStore: store });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const told = (store.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(told).toContain('A sentence or a row removed for verdict wording is left out, not reworded.');
  });

  it('answers a question about a shared other end for the two elements it read of five in view, one sentence for each read citing its line, says what was not read citing c1, and removes a sentence that generalises to every element', async () => {
    // the result of the read of the second anchor is its own: the expansion of A-1 with the ends renamed, so that it holds A-2 and its two neighbours A-4 and A-5
    const expandOfSecond = () => JSON.parse(JSON.stringify(expandResult()).replaceAll('A-3', 'A-5').replaceAll('A-2', 'A-4').replaceAll('A-1', 'A-2'));
    const nodes = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map((id) => nodeOf(id, `${V.title} ${id}`));
    const keys = nodes.map((node) => JSON.stringify(['node', node.ref.sourceId, node.ref.entityType, node.ref.stableId]));
    const first = { text: `The read of the neighbours of ${V.title} A-1 returned 2 matches shown, exact.`, cites: ['n1', 's1'] };
    const second = { text: `The read of the neighbours of ${V.title} A-2 returned 2 matches shown, exact.`, cites: ['n2', 's2'] };
    const generalising = { text: `All the ${V.anchor} elements on screen have an other end of their own, and none of them share one.`, cites: ['n1', 'n2'] };
    const notRead = { text: 'The other elements were not read: one read each, more than this turn allows.', cites: ['c1'] };
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'expand', args: { entityType: V.anchor, stableId: 'A-1', neighborType: V.anchor } }])
      .respondWithTools([{ name: 'expand', args: { entityType: V.anchor, stableId: 'A-2', neighborType: V.anchor } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [first, second, generalising] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [first, second, notRead] }] } }])
      .respond(new AIMessage('Done.'));
    const store = createMemoryAssistantRunStore();
    // five elements in view and three reads allowed (the view and two anchors): the other three cannot be read in this turn
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 9, maxInputTokens: 60_000 }, viewNodes: nodes, loopSteps: 3, run: (_continuing, asked) => ({ status: 'ok', result: JSON.stringify(asked).includes('A-2') ? expandOfSecond() : expandResult() }), runStore: store });
    const answer = await answerOf(r.route.handler(r.request({ ...BODY, viewElementKeys: keys })));
    expect(JSON.stringify(answer)).not.toContain('have an other end of their own');
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: first.text }, { text: second.text }, { text: notRead.text, cites: ['c1'] }] }], reads: [{ tool: 'view' }, { tool: 'expand' }, { tool: 'expand' }] });
    const told = (store.runs[0]?.callStarts ?? []).map((start) => start.valuesText).join('\n');
    expect(told).toContain('c1: view coverage: 5 entities shown');
    expect(told).toContain('Checked: 2 sentences kept, 1 removed');
  });

  it('keeps a sentence that names the element and states the count when it cites the element and the degree line, and removes it when it cites the line alone', async () => {
    const answered = (cites: string[]) =>
      fakeModel()
        .respondWithTools([{ name: 'view', args: {} }])
        .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
        .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 has 169,756 ${V.other} (exact).`, cites }] }] } }])
        .respond(new AIMessage('Done.'));
    const both = await rig({ reply: VIEW, agent: { model: answered(['n1', 's1']), maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(both.route.handler(both.request(VIEW_BODY)))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['n1', 's1'] }] }] });
    const lineOnly = await rig({ reply: VIEW, agent: { model: answered(['s1']), maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(lineOnly.route.handler(lineOnly.request(VIEW_BODY)))).toMatchObject({ status: 'not-answered' });
  });

  it('gives a sentence that cites only a read line a marker of its own: a citation of the kind read with what the server wrote of that read', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }, { text: 'The degree read states all types 184,533 (exact).', cites: ['s1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 8 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['n1'] }, { cites: ['s1'] }] }] });
    const citations = (answer as { citations: { key: string; kind: string; label?: string; finding?: string }[] }).citations;
    expect(citations.find((citation) => citation.key === 's1')).toMatchObject({ kind: 'read', label: 'degree-preview' });
    expect(citations.find((citation) => citation.key === 's1')?.finding).toContain('all types 184,533 (exact)');
    expect(citations.filter((citation) => citation.kind === 'read')).toHaveLength(1);
  });

  it('removes a count that the degree read does not state', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `The ${V.other} count is 170,000, which is exact.`, cites: ['s1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'not-answered' });
  });

  it('shows the fixed sentence of a pointer the model names, and still removes the model\'s own uncited sentence', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'Use the Expand action to add them.', cites: [] }, { text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }], pointer: 'canvas-expand' } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', pointer: ASSISTANT_POINTER_SENTENCES['canvas-expand'] });
    expect(JSON.stringify(answer)).not.toContain('Use the Expand action');
    const none = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }], pointer: 'anything-else' } }])
      .respond(new AIMessage('Done.'));
    const other = await rig({ reply: VIEW, agent: { model: none } });
    expect(JSON.stringify(await answerOf(other.route.handler(other.request(VIEW_BODY))))).not.toContain('anything-else');
  });

  it('does not mark a limit on an answer given on the last call the turn may make, because the limit cut nothing short', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 3 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.` }] }] });
    expect(answer).not.toHaveProperty('stoppedAt');
    expect(answer).toMatchObject({ lastCallNote: ASSISTANT_LAST_CALL_SENTENCE });
  });

  it('says nothing of the last call when the answer that stands was written earlier and the last answer kept nothing', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} Z-9 is in view.`, cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model, maxCalls: 4 } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.` }] }] });
    expect(answer).not.toHaveProperty('lastCallNote');
  });

  it('carries no note on an answer given while reads were still allowed', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(() => {
        throw new Error('a call after an accepted answer');
      });
    const r = await rig({ reply: VIEW, agent: { model: whole } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.` }] }] });
    expect(modelEvents(r).filter((event) => event.result === 'failed')).toHaveLength(0);
    expect(modelEvents(r)).toHaveLength(2);
    const removed = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }, { text: `${V.title} Z-9 is in view.`, cites: ['n9'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(() => {
        throw new Error('a call after an accepted answer');
      });
    const again = await rig({ reply: VIEW, agent: { model: removed, maxCalls: 8 } });
    expect(await answerOf(again.route.handler(again.request(VIEW_BODY)))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.` }] }] });
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} Z-9 is in view.`, cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.` }] }] });
  });

  it('suppresses the whole draft when a sentence holds verdict wording, even if the others pass', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }, { text: `${V.title} A-2 is guilty of fraud.`, cites: ['n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });

  it('answers over what was read when the steps limit is reached, carrying the limit it stopped at', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are listed.`, cites: ['r1', 'r2'] }] }] } }])
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
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are listed.` }] }] });
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'Rapid movement of funds is one of the shapes listed.', cites: ['t1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, typology: ['Rapid movement of funds', 'Structuring'] });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['t1'] }] }], reads: [{ tool: 'typology', kind: 'typology', read: true }]  });
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} Z-9`], cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'table', table: { columns: ['Element'], rows: [{ cites: ['n1'] }], droppedRows: 1 } }] });
  });

  it('asks again for a table that is not in the shape, and shows nothing of it', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: ['a', 'b'], cites: ['n1'] }] }] } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer.status).toBe('not-answered');
  });
});

describe('the blocks of an agent answer', () => {
  const TABLE = ok('{"route":"view","form":"table"}');
  const sentence = (text: string) => ({ kind: 'sentences', sentences: [{ text, cites: ['n1'] }] });
  const table = (rows: number, cell = `${V.title} A-1`) => ({ kind: 'table', columns: ['Element'], rows: Array.from({ length: rows }, (_, index) => ({ cells: [cell], cites: ['n1'] })) });
  const answerWith = async (reply: unknown, blocks: readonly unknown[]) => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { blocks } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: reply as never, agent: { model } });
    return answerOf(r.route.handler(r.request(VIEW_BODY)));
  };

  it('keeps the order of the model: sentences then a table, and a table then sentences', async () => {
    const first = await answerWith(TABLE, [sentence(`${V.title} A-1 is in view.`), table(1)]);
    expect(first).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences' }, { kind: 'table' }] });
    const second = await answerWith(TABLE, [table(1), sentence(`${V.title} A-1 is in view.`)]);
    expect(second).toMatchObject({ status: 'answered', blocks: [{ kind: 'table' }, { kind: 'sentences' }] });
  });

  it('writes the note of a table itself, ending with the fixed sentence', async () => {
    const answer = await answerWith(TABLE, [table(1)]);
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'table', table: { note: expect.stringMatching(/Each row selects its elements on the graph\.$/) } }] });
  });

  it('shows nothing of an answer with a fifth block', async () => {
    const answer = await answerWith(TABLE, [sentence('One.'), sentence('Two.'), sentence('Three.'), sentence('Four.'), sentence('Five.')]);
    expect(answer.status).toBe('not-answered');
  });

  it('shows nothing of a table block on a turn that did not ask for a table', async () => {
    const answer = await answerWith(VIEW, [table(1)]);
    expect(answer.status).toBe('not-answered');
  });

  it('cuts the rows of the later tables beyond 25 in all, counts them as not shown, and states the rows shown in the title and the coverage line', async () => {
    const answer = await answerWith(TABLE, [table(20), table(20)]);
    const blocks = (answer as { blocks: { kind: string; table?: { rows: unknown[]; title: string; moreNotShown?: number } }[] }).blocks;
    expect(blocks.flatMap((block) => block.table?.rows ?? [])).toHaveLength(25);
    expect(blocks[0]?.table?.title).toMatch(/20 rows$/);
    expect(blocks[1]?.table?.title).toMatch(/5 rows$/);
    expect(blocks[1]?.table?.moreNotShown).toBe(15);
    expect((answer as { coverage: { summary: string } }).coverage.summary).toMatch(/^20 .*5 /);
  });

  it('counts the rows of a table with no row left, beside the sentences that stand', async () => {
    const dropped = { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} Z-9`], cites: ['n9'] }, { cells: [`${V.title} Z-8`], cites: ['n8'] }] };
    const answer = await answerWith(TABLE, [sentence(`${V.title} A-1 is in view.`), table(1), dropped]);
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences' }, { kind: 'table', table: { droppedRows: 2 } }] });
  });

  it('counts the rows of a table with no row left in the closing event when no table is shown', async () => {
    const dropped = { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} Z-9`], cites: ['n9'] }, { cells: [`${V.title} Z-8`], cites: ['n8'] }] };
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { blocks: [sentence(`${V.title} A-1 is in view.`), dropped] } }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences' }] });
    const closed = r.events.filter((event) => event.action === 'assistant.turn.closed');
    expect(JSON.stringify(closed[0]?.detail)).toMatch(/"tableRowsDropped":2/);
  });

  it('moves the dropped rows of a table the totals leave out to the table before it', async () => {
    const mixed = { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} Z-9`], cites: ['n9'] }] };
    const answer = await answerWith(TABLE, [table(25), mixed]);
    const tables = (answer as { blocks: { kind: string; table?: { droppedRows?: number; moreNotShown?: number } }[] }).blocks.filter((block) => block.kind === 'table');
    expect(tables).toHaveLength(1);
    expect(tables[0]?.table).toMatchObject({ droppedRows: 1, moreNotShown: 1 });
  });

  it('suppresses the whole answer when one row of a table holds verdict wording, even beside a clean sentences block', async () => {
    const bad = { kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1 is guilty of fraud`], cites: ['n1'] }] };
    const answer = await answerWith(TABLE, [sentence(`${V.title} A-1 is in view.`), bad]);
    expect(answer.status).toBe('not-answered');
  });

  it('cuts the sentences beyond 12 in all, from the end', async () => {
    const many = (count: number) => ({ kind: 'sentences', sentences: Array.from({ length: count }, (_, index) => ({ text: `${V.title} A-1 is in view.`, cites: ['n1'] })) });
    const answer = await answerWith(VIEW, [many(8), many(8)]);
    expect(sentencesOfBlocks((answer as { blocks: AssistantBlocks }).blocks)).toHaveLength(12);
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} Z-9 is in view.`, cites: ['n9'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('not a route at all'), agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['n1'] }] }] });
  });

  it('tells a streamed turn each read as a step and that it is answering, and no model text', async () => {
    const emitted: { phase: string }[] = [];
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: 'The read of byId found nothing.', cites: ['s1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ASK, agent: { model }, run: () => ({ status: 'ok', result: zeroResult() }) });
    const answer = await answerOf(r.route.handler(r.request()));
    if (answer.status !== 'answered' || !('blocks' in answer)) throw new Error(`not a sentence answer: ${JSON.stringify(answer).slice(0, 200)}`);
    expect(sentencesOfBlocks(answer.blocks)[0]?.cites).toEqual(['s1']);
    // a cite to a read line is no element: it carries a citation of the kind read, which the card draws as a marker, and no element citation
    expect(answer.citations.filter((citation) => citation.key === 's1').map((citation) => citation.kind)).toEqual(['read']);
  });

  it('shows the fixed sentence for a type the mapping does not describe beside a table and beside sentences', async () => {
    const types = [V.anchor];
    const table = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }] }], noDescription: [V.anchor] } }])
      .respond(new AIMessage('Done.'));
    const a = await rig({ reply: ok(`{"route":"view","types":["${V.anchor}"],"form":"table"}`), agent: { model: table }, types });
    const tabled = await answerOf(a.route.handler(a.request(VIEW_BODY)));
    expect(tabled).toMatchObject({ status: 'answered', route: 'view', noDescription: `The mapping has no description for ${V.anchor}, so I cannot say what it means.` });
    const sentences = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }], noDescription: [V.anchor] } }])
      .respond(new AIMessage('Done.'));
    const b = await rig({ reply: ok(`{"route":"view","types":["${V.anchor}"]}`), agent: { model: sentences }, types });
    expect(await answerOf(b.route.handler(b.request(VIEW_BODY)))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['n1'] }] }], noDescription: expect.stringContaining('no description') });
  });

  it('says in the closing event that property values were sent when a read carried them', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, viewNodes: [nodeOf('A-1', `${V.title} A-1`)] });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const closed = r.events.find((event) => event.action === 'assistant.turn.closed');
    expect((closed?.detail as { turn: { propertyValuesSent?: boolean } }).turn.propertyValuesSent).toBe(false);
  });

  it('titles a table of the elements it reads and counts them, in the server\'s words', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-1`], cites: ['n1'] }, { cells: [`${V.title} A-2`], cites: ['n2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model } });
    const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'table', table: { title: expect.stringMatching(/2 rows/) } }], coverage: { summary: expect.stringMatching(/2 of 2/) }  });
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are listed.`, cites: ['r1', 'r2'] }] }] } }])
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
    shared: { parameters: ['id'], template: 'shared-attribute', settings: { ref: { entityType: V.anchor, stableId: '$id' }, attributeType: 'shape', via: 'USES_SHAPE' } },
    anchorById: { parameters: ['id'], template: 'entity', settings: { ref: { entityType: V.anchor, stableId: '$id' } } },
  };

  it('carries the follow-ups Ask\'s own answer to the read has, and none for a view question', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'shared', args: { id: 'A-1' } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 and ${V.title.toLowerCase()} A-2 are listed.`, cites: ['r1', 'r2'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), agent: { model }, intents: INTENTS });
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', blocks: expect.anything(), followUps: expect.arrayContaining([expect.objectContaining({ choice: expect.objectContaining({ intent: 'anchorById' }) })]) });
    const viewModel = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model }, runStore: store });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    const [run] = store.runs;
    const agentEvents = modelEvents(r);
    expect(agentEvents).toHaveLength(2);
    for (const event of agentEvents) expect(event.detail).toMatchObject({ ai: { runId: run?.id } });
    expect(run?.callStarts).toHaveLength(1 + agentEvents.length);
    expect(run?.callStarts[0]?.toolsOffered).toBeUndefined();
    for (const start of run?.callStarts.slice(1) ?? []) expect(start.toolsOffered?.split(',')).toEqual(expect.arrayContaining(['answer', 'view']));
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
        .respondWithTools([{ name: 'degree-preview', args: { entityType: V.anchor, stableId: 'A-1' } }])
        .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
        .respond(new AIMessage('Done.'));
    // the sizes depend on the texts of the turn, so the limit at which the second read is left out is found, from the top down, not written
    let answer: Awaited<ReturnType<typeof answerOf>> | undefined;
    for (let limit = 14_000; limit >= 3_000 && !(answer !== undefined && 'stoppedAt' in answer && answer.stoppedAt === 'input'); limit -= 100) {
      const fits = await rig({ reply: VIEW, agent: { model: scripted(), maxCalls: 8, maxInputTokens: limit }, run: () => ({ status: 'ok', result: degreeResult() }) });
      answer = await answerOf(fits.route.handler(fits.request(VIEW_BODY)));
    }
    expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'input', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }], reads: [{ tool: 'view' }] });
    expect(JSON.stringify(answer)).not.toContain('degree-preview');
    const none = await rig({ reply: VIEW, agent: { model: scripted(), maxCalls: 8, maxInputTokens: 3_000 }, run: () => ({ status: 'ok', result: degreeResult() }) });
    expect(await answerOf(none.route.handler(none.request(VIEW_BODY)))).toMatchObject({ status: 'limit', limit: 'input' });
  }, 30_000);

  describe('a read left out because the next request is too large', () => {
    /** The answer of the first limit, from the top down, at which the read was left out and the turn still answered: the sizes depend on the texts of the turn, so the limit is found, not written. */
    const firstTrimmed = async (scripted: () => ReturnType<typeof fakeModel>, over: { loopSteps?: number } = {}): Promise<Awaited<ReturnType<typeof answerOf>>> => {
      for (let limit = 16_000; limit >= 3_000; limit -= 200) {
        const r = await rig({ reply: VIEW, agent: { model: scripted(), maxCalls: 8, maxInputTokens: limit }, ...(over.loopSteps === undefined ? {} : { loopSteps: over.loopSteps }), run: () => ({ status: 'ok', result: expandEarlierResult() }) });
        const answer = await answerOf(r.route.handler(r.request(VIEW_BODY)));
        if ('stoppedAt' in answer && answer.stoppedAt === 'input') return answer;
      }
      throw new Error('no limit left a read out');
    };
    const expand = { name: 'expand', args: { entityType: V.anchor, stableId: 'A-1', neighborType: V.anchor } };

    it('judges the answer against the keys the model holds: the read that would shift them is taken back, the cite n1 stays the first element of the view, and the reads and the coverage list the view only', async () => {
      const answer = await firstTrimmed(() =>
        fakeModel()
          .respondWithTools([{ name: 'view', args: {} }])
          .respondWithTools([expand])
          .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
          .respond(new AIMessage('Done.')),
      );
      expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }], citations: [{ key: 'n1', ref: { stableId: 'A-1' } }], reads: [{ tool: 'view' }], stoppedAt: 'input' });
      expect(JSON.stringify(answer)).not.toContain('A-0');
      const viewOnly = await rig({ reply: VIEW, agent: { model: fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }]).respond(new AIMessage('Done.')), maxCalls: 8 } });
      const plain = await answerOf(viewOnly.route.handler(viewOnly.request(VIEW_BODY)));
      expect('coverage' in answer && 'coverage' in plain && answer.coverage).toEqual('coverage' in plain && plain.coverage);
    }, 30_000);

    it('says the limit of the input, not that of the steps, when the read left out was the one a limit of steps had stopped', async () => {
      const answer = await firstTrimmed(
        () =>
          fakeModel()
            .respondWithTools([{ name: 'view', args: {} }])
            .respondWithTools([expand])
            .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
            .respond(new AIMessage('Done.')),
        { loopSteps: 1 },
      );
      expect(answer).toMatchObject({ status: 'answered', stoppedAt: 'input', reads: [{ tool: 'view' }] });
    }, 30_000);
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
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences: [{ text: `${V.title} A-1 is in view.`, cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('{"route":"meaning","types":["nonexistent"]}'), agent: { model }, types: [V.anchor] });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY)))).toMatchObject({ status: 'answered', route: 'view', blocks: [{ kind: 'sentences', sentences: [{ cites: ['n1'] }] }] });
  });
});

describe('counts and what the model is told of a removal, through the answer tool', () => {
  const W = V.anchor.endsWith('y') ? `${V.anchor.slice(0, -1)}ies` : `${V.anchor}s`;
  const listed = (count: number): AskRunResult => askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: count, scope: 'test' }, matchIds: [], nodes: Array.from({ length: count }, (_, index) => nodeOf(`A-${index + 1}`)), edges: [], notices: [], warnings: [] } });
  const keys = (count: number): string[] => Array.from({ length: count }, (_, index) => `r${index + 1}`);
  const answering = (...answers: { text: string; cites: string[] }[][]) => {
    const model = fakeModel().respondWithTools([{ name: 'byId', args: { id: 'A-1' } }]);
    for (const sentences of answers) model.respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'sentences', sentences }] } }]);
    return model.respond(new AIMessage('Done.'));
  };
  const feedbackOf = (model: ReturnType<typeof fakeModel>): string[] => (model.calls.at(-1)?.messages ?? []).filter((message) => message.type === 'tool').map((message) => String(message.content));
  const turn = async (model: ReturnType<typeof fakeModel>, result: AskRunResult, reply = ASK, maxCalls?: number) => {
    const r = await rig({ reply, agent: { model, ...(maxCalls === undefined ? {} : { maxCalls }) }, run: () => ({ status: 'ok', result }) });
    return answerOf(r.route.handler(r.request()));
  };

  it('shows 25 widgets over the 25 elements a read listed and cited, and removes 26', async () => {
    expect(await turn(answering([{ text: `25 ${W} are listed.`, cites: keys(25) }]), listed(25))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `25 ${W} are listed.` }] }] });
    expect(await turn(answering([{ text: `26 ${W} are listed.`, cites: keys(25) }]), listed(25))).toMatchObject({ status: 'not-answered' });
  });

  it('keeps "Of those five widgets" when the sentence cites the five, and removes it, with the reason told to the model, when it cites only the one it speaks of', async () => {
    const text = `Of those five ${W}, the first is shown first.`;
    expect(await turn(answering([{ text, cites: keys(5) }]), listed(5))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text }] }] });
    const model = answering([{ text, cites: ['r1'] }], [{ text: `The first ${V.anchor} is shown first.`, cites: ['r1'] }]);
    expect(await turn(model, listed(5))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `The first ${V.anchor} is shown first.` }] }] });
    expect(feedbackOf(model).join('\n')).toContain(removalNoteOf([{ text, reason: 'number' }]));
  });

  it.each([`In total there are 2 ${W}.`, `At least 2 ${W} are listed.`, `2 ${W} are not yet retrieved.`])('removes a count of the cited elements that is said of another population: %s', async (text) => {
    expect(await turn(answering([{ text, cites: keys(2) }]), listed(2))).toMatchObject({ status: 'not-answered' });
  });

  it('removes a number stated over a lower-bound count without its label', async () => {
    const model = answering([{ text: 'The read left 149 not yet retrieved.', cites: ['s1'] }]);
    expect(await turn(model, lowerBoundResult())).toMatchObject({ status: 'not-answered' });
    expect(feedbackOf(model).join('\n')).toContain('without its label as written');
  });

  it('names each removed sentence and its reason to the model, and nothing when none is removed', async () => {
    const kept = { text: `${V.title} A-1 is listed.`, cites: ['r1'] };
    const removed = { text: `${V.title} A-2 has 7311 rows.`, cites: ['r2'] };
    const model = answering([kept, removed]);
    const answer = await turn(model, listed(2));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: kept.text }] }] });
    expect(JSON.stringify(answer)).not.toContain('Removed:');
    expect(JSON.stringify(answer)).not.toContain(removed.text);
    const [, told] = feedbackOf(model);
    expect(told).toMatch(/^Checked: 1 sentences kept, 1 removed\. Your next answer replaces this one if any of its sentences is kept: call answer again with every sentence you want shown, the kept ones and each removed one corrected/u);
    expect(told).toContain('Leave a sentence out when no line holds its figure');
    expect(told.endsWith(`\n${removalNoteOf([{ text: removed.text, reason: 'number' }])}`)).toBe(true);
    const clean = answering([kept]);
    await turn(clean, listed(2));
    expect(feedbackOf(clean).join('\n')).not.toContain('Removed:');
  });

  it('echoes only the model\'s own sentence and fixed words for a sentence that names what no read returned', async () => {
    const invented = { text: `${V.title} Zed-9 is listed.`, cites: ['r1'] };
    const model = answering([invented]);
    await turn(model, listed(2));
    const [, told] = feedbackOf(model);
    expect(told).toMatch(/^Checked: 0 sentences kept, 1 removed\. Your next answer replaces this one if any of its sentences is kept/u);
    expect(told.endsWith(`\n${removalNoteOf([{ text: invented.text, reason: 'name' }])}`)).toBe(true);
    expect(told).not.toContain('A-2');
  });

  it('judges a sentence said again corrected like any other', async () => {
    const model = answering([{ text: `3 ${W} are listed.`, cites: keys(2) }], [{ text: `2 ${W} are listed.`, cites: keys(2) }]);
    expect(await turn(model, listed(2))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: `2 ${W} are listed.` }] }] });
  });

  it('refuses a reply that holds verdict wording whole on the last call it may make, though one sentence is valid', async () => {
    const model = answering([{ text: `${V.title} A-1 is listed.`, cites: ['r1'] }, { text: `${V.title} A-2 is guilty of fraud.`, cites: ['r2'] }]);
    const answer = await turn(model, listed(2), ASK, 3);
    expect(answer).toMatchObject({ status: 'not-answered' });
    expect(JSON.stringify(answer)).not.toContain(`${V.title} A-1 is listed`);
    expect(JSON.stringify(answer)).not.toContain('Removed:');
    expect(JSON.stringify(answer)).not.toContain('guilty');
  });

  it('names the reason of a table row that is removed, in the words of a table', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`2 ${W}`], cites: ['n1', 'n2'] }, { cells: [`${V.title} A-1`], cites: ['n1'] }] }] } }])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: ok('{"route":"view","form":"table"}'), agent: { model } });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    expect(feedbackOf(model).join('\n')).toContain(removalNoteOf([{ text: `2 ${W}`, reason: 'cell' }]));
  });

  describe('with the rule that verifies a count taken out, or the check taken out', () => {
    const answerWithChecks = async (checks: (real: typeof import('../case-summary/checks.js')) => Record<string, unknown>, text: string, result: AskRunResult = listed(25), cites: string[] = keys(25)) => {
      vi.resetModules();
      vi.doMock('../case-summary/checks.js', async (original) => checks(await original<typeof import('../case-summary/checks.js')>()));
      const testing = await import('../testing/assistant-rig.js');
      const model = answering([{ text, cites }]);
      const r = await testing.rig({ reply: ASK, agent: { model }, run: () => ({ status: 'ok', result }) });
      const answer = await testing.answerOf(r.route.handler(r.request()));
      vi.doUnmock('../case-summary/checks.js');
      vi.resetModules();
      return answer;
    };

    it('shows no count when the elements are no longer typed, so the test that shows 25 depends on the rule', async () => {
      const answer = await answerWithChecks((real) => ({ judgeSentences: (...args: Parameters<typeof real.judgeSentences>) => real.judgeSentences(args[0], { ...args[1], elementTypes: undefined }, args[2]) }), `25 ${W} are listed.`);
      expect(answer).toMatchObject({ status: 'not-answered' });
    });

    const keepsEverySentence = () => ({ judgeSentences: (sentences: readonly { text: string; cites: string[] }[]) => ({ kept: sentences, removed: 0, rejected: [], verdictFound: false, keysStripped: 0, keysRemoved: 0 }) });

    it.each([`26 ${W} are listed.`, `In total there are 25 ${W}.`, `At least 25 ${W} are listed.`, `25 ${W} are not yet retrieved.`])('shows %s when the check keeps every sentence, so the test that removes it depends on the check', async (text) => {
      expect(await answerWithChecks(keepsEverySentence, text)).toMatchObject({ status: 'answered' });
    });

    it('shows the number stated over a lower-bound count when the check keeps every sentence', async () => {
      expect(await answerWithChecks(keepsEverySentence, 'The read left 149 not yet retrieved.', lowerBoundResult(), ['s1'])).toMatchObject({ status: 'answered' });
    });
  });
});
