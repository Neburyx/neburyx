import { afterAll, describe, expect, it } from 'vitest';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { askRunResultSchema, type AiNotesCapability, type AskRunResult } from '@neburyx/contracts';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, VIEW_KEYS, V, answerOf, expandResult, nodeOf, ok, rig, routeAsk } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore } from './run-store.js';
import { READ_VIEW_FIRST } from './agent-turn.js';
import { assembleResults } from './tool-answer.js';

afterAll(removeAskFolders);

const VIEW = ok('{"route":"view"}');
const TABLE = ok('{"route":"view","form":"table"}');
const plural = V.anchor.endsWith('y') ? `${V.anchor.slice(0, -1)}ies` : `${V.anchor}s`;
const answer = (blocks: unknown[]) => ({ name: 'answer', args: { blocks } });
const sentences = (...list: { text: string; cites: string[] }[]) => answer([{ kind: 'sentences', sentences: list }]);

// What each test shows is how the turn behaves today where an answer went wrong in a hand test; the change that mends a fault changes its test.
describe('what the loop is given about the elements on screen', () => {
  const noNotes: AiNotesCapability = { read: () => Promise.resolve({ entries: [], version: 1, save: { state: 'unsaved', savedAt: null } }), append: () => Promise.reject(new Error('not used')), canWrite: () => Promise.resolve() };

  it('sends the model no element of the view and nothing of the selection until it reads the view', async () => {
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([sentences({ text: `${V.title} A-1 is in view.`, cites: ['n1'] })])
      .respond(new AIMessage('Done.'));
    const runStore = createMemoryAssistantRunStore();
    const r = await rig({ reply: VIEW, agent: { model }, runStore });
    await answerOf(r.route.handler(r.request({ ...VIEW_BODY, selectionKeys: [VIEW_KEYS[0] ?? ''] })));
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    const [router, first, afterView] = runStore.runs[0]?.callStarts ?? [];
    expect(router?.valuesText).toContain('(selected)');
    expect(first?.valuesText).not.toContain('A-1');
    expect(first?.valuesText).not.toContain('(selected)');
    expect(afterView?.valuesText).toContain('A-1');
  });

  const notes: AiNotesCapability = {
    ...noNotes,
    read: () => {
      const ref = nodeOf('A-1').ref;
      const cites = [{ key: 'n1', kind: 'entity', ref }];
      return Promise.resolve({ entries: [{ tokenId: 'tok-1', generatedBy: 'person-1', modelRef: 'configured-model', promptId: 'case-summary', promptVersion: '1', generatedAt: '2026-11-15T10:00:00.000Z', wordListVersion: 2, label: 'AI-drafted', sentences: [{ text: `‹${V.anchor}#1› is listed.`, placeholders: [{ name: `‹${V.anchor}#1›`, descriptor: { kind: 'entity', ref } }], cites }], inputRefs: cites }], version: 1, save: { state: 'unsaved', savedAt: null } });
    },
  };
  const nothingNamed = `No ${V.anchor} is identified in the question or in the elements on screen.`;
  const seen = `${V.title} A-1 is in view.`;
  const told = (model: ReturnType<typeof fakeModel>): string[] => (model.calls.at(-1)?.messages ?? []).filter((message) => message.type === 'tool').map((message) => String(message.content));
  const turn = async (model: ReturnType<typeof fakeModel>, options: Parameters<typeof rig>[0] = {}, body: unknown = VIEW_BODY, capability: AiNotesCapability = notes) => {
    const r = await rig({ reply: VIEW, ...options, agent: { model, ...options.agent } });
    return { r, given: await answerOf(r.route.handler(r.request(body, { aiNotes: capability }))) };
  };

  it.each([
    ['no sentence', noNotes],
    ['a sentence that names elements', notes],
  ])('refuses once an answer made after only a read of notes with %s, and judges the answer made after the view', async (_name, capability) => {
    const model = fakeModel()
      .respondWithTools([{ name: 'ai-notes', args: {} }])
      .respondWithTools([sentences({ text: nothingNamed, cites: ['s1'] })])
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([sentences({ text: seen, cites: ['n1'] })])
      .respond(new AIMessage('Done.'));
    const { r, given } = await turn(model, { maxInputTokens: 200_000 }, VIEW_BODY, capability);
    expect(told(model)).toContain(READ_VIEW_FIRST);
    expect(given).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: seen }] }] });
    expect(JSON.stringify(given)).not.toContain(nothingNamed);
    expect(r.elementReads.length).toBeGreaterThan(0);
  });

  it('judges a second answer as usual, whether or not the view was read after the refusal', async () => {
    const model = fakeModel()
      .respondWithTools([sentences({ text: nothingNamed, cites: [] })])
      .respondWithTools([{ name: 'ai-notes', args: {} }])
      .respondWithTools([sentences({ text: nothingNamed, cites: ['s1'] })])
      .respond(new AIMessage('Done.'));
    const { given } = await turn(model, {}, VIEW_BODY, noNotes);
    expect(told(model).filter((content) => content === READ_VIEW_FIRST)).toHaveLength(1);
    expect(given).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: nothingNamed }] }] });
  });

  it.each([
    ['after a read of the source that returned elements', [{ name: 'byId', args: { id: 'A-1' } }], 'r1', {}, VIEW_BODY],
    ['with no element in view', [{ name: 'ai-notes', args: {} }], 's1', {}, { ...VIEW_BODY, viewElementKeys: [] }],
    ['with one call left, which could not both read and answer', [{ name: 'ai-notes', args: {} }], 's1', { agent: { maxCalls: 4 } }, VIEW_BODY],
    ['with no step left', [{ name: 'ai-notes', args: {} }], 's1', { loopSteps: 1 }, VIEW_BODY],
  ] as const)('judges the first answer as usual %s', async (_name, call, cite, options, body) => {
    const text = cite === 'r1' ? `${V.title} A-1 is listed.` : nothingNamed;
    const model = fakeModel().respondWithTools([...call]).respondWithTools([sentences({ text, cites: [cite] })]).respond(new AIMessage('Done.'));
    const { given } = await turn(model, options as Parameters<typeof rig>[0], body, noNotes);
    expect(told(model)).not.toContain(READ_VIEW_FIRST);
    expect(given).toMatchObject({ status: 'answered' });
  });

  it('tells the model that this and the elements on screen are the view, to be read before they are spoken of', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([sentences({ text: seen, cites: ['n1'] })]).respond(new AIMessage('Done.'));
    const runStore = createMemoryAssistantRunStore();
    await turn(model, { runStore });
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    expect(runStore.runs[0]?.callStarts[1]?.instructionsText).toContain('call view before you say which element a message means, what is or is not on screen, or that nothing is identified');
  });
});

describe('the line of a folded relationship', () => {
  const lineOf = (memberCount: { quality: 'exact' | 'lowerBound'; value: number }) => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('an expansion');
    const [from, to] = [nodeOf('A-1').ref, nodeOf('A-2').ref];
    const folded = { ref: { sourceId: from.sourceId, aggregate: { type: V.links[1], from, to } }, from, to, type: V.links[1], direction: 'out', semantics: 'stored', memberCount: { ...memberCount, scope: 'test' }, properties: [], evidenceRefs: [], qualityFlags: [] };
    const result = askRunResultSchema.parse({ ...base, result: { ...base.result, edges: [folded] } });
    return [...assembleResults([{ tool: 'shared', result }]).assembled.lines.values()].find((found) => found.includes('members'));
  };

  it.each([
    [{ quality: 'exact', value: 3 }, 'members: 3 (exact)'],
    [{ quality: 'lowerBound', value: 1 }, 'members: ≥ 1 (lower bound)'],
  ] as const)('carries its member count with its label: %o', (count, expected) => {
    expect(lineOf(count)).toContain(expected);
  });

  it('is explained to the model, which is told to name relationships, only when asked how many, with the quality as written', async () => {
    const model = fakeModel().respondWithTools([{ name: 'view', args: {} }]).respondWithTools([sentences({ text: `${V.title} A-1 is in view.`, cites: ['n1'] })]).respond(new AIMessage('Done.'));
    const runStore = createMemoryAssistantRunStore();
    const r = await rig({ reply: VIEW, agent: { model }, runStore });
    await answerOf(r.route.handler(r.request(VIEW_BODY)));
    for (let step = 0; step < 10; step += 1) await Promise.resolve();
    const told = runStore.runs[0]?.callStarts[1]?.instructionsText ?? '';
    expect(told).toContain('the number of relationships of the source that the one line stands for');
    expect(told).toContain('Never write the word members, and state that figure only when the message asks how many relationships there are');
    expect(told).toContain('keeping the quality as the line writes it');
  });
});

describe('a table that lists some of the elements read', () => {
  it('is accepted, with only the coverage line to say how many were left out', async () => {
    const nodes = ['A-1', 'A-2', 'A-3', 'A-4', 'A-5'].map((id) => nodeOf(id));
    const model = fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([answer([{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-2`], cites: ['n2'] }] }])])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: TABLE, agent: { model }, viewNodes: nodes });
    const given = await answerOf(r.route.handler(r.request({ ...VIEW_BODY, viewElementKeys: nodes.map((node) => JSON.stringify(['node', node.ref.sourceId, node.ref.entityType, node.ref.stableId])) })));
    expect(given).toMatchObject({ status: 'answered', blocks: [{ kind: 'table', table: { rows: [{ cells: [`${V.title} A-2`] }] } }], coverage: { summary: expect.stringMatching(/^1 of 5 .+ read shown · exact$/u) as string } });
  });
});

describe('a question for the largest', () => {
  const VALUES = [1200.5, 1664.72, 99];
  const listed: AskRunResult = askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: VALUES.length, scope: 'test' }, matchIds: [], nodes: VALUES.map((value, index) => ({ ...nodeOf(`A-${index + 1}`), properties: [{ key: 'amountValue', value, dataClass: 'number', masked: false }] })), edges: [], notices: [], warnings: [] } });
  const turn = async (text: string, cites: string[], reads = 1) => {
    const model = fakeModel();
    for (let read = 0; read < reads; read += 1) model.respondWithTools([{ name: 'byId', args: { id: `A-${read + 1}` } }]);
    model.respondWithTools([sentences({ text, cites })]).respond(new AIMessage('Done.'));
    const r = await rig({ reply: routeAsk('shared', { id: 'A-1' }), agent: { model }, run: () => ({ status: 'ok', result: listed }) });
    return answerOf(r.route.handler(r.request(BODY)));
  };
  const largest = `${V.title} A-2 has the largest amountValue, 1664.72.`;
  const limited = `Of the ${plural} in the read, ${V.title} A-2 has the largest amountValue, 1664.72.`;

  it('is removed when it cites only some of the elements of the type', async () => {
    expect(await turn(largest, ['r1', 'r2'])).toMatchObject({ status: 'not-answered' });
  });

  it('stands in the form limited to one read that cites every element of it', async () => {
    expect(await turn(limited, ['r1', 'r2', 'r3', 's1'])).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text: limited }] }] });
  });
});
