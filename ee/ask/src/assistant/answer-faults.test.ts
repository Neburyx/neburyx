import { afterAll, describe, expect, it } from 'vitest';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { askRunResultSchema, type AiNotesCapability, type AskRunResult } from '@neburyx/contracts';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, VIEW_BODY, VIEW_KEYS, V, answerOf, expandResult, nodeOf, ok, rig, routeAsk } from '../testing/assistant-rig.js';
import { createMemoryAssistantRunStore } from './run-store.js';
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

  it('accepts an answer about the screen from a turn that read no element', async () => {
    const text = `No ${V.anchor} is identified in the question or in the elements on screen.`;
    const model = fakeModel()
      .respondWithTools([{ name: 'ai-notes', args: {} }])
      .respondWithTools([sentences({ text, cites: ['s1'] })])
      .respond(new AIMessage('Done.'));
    const r = await rig({ reply: VIEW, agent: { model } });
    expect(await answerOf(r.route.handler(r.request(VIEW_BODY, { aiNotes: noNotes })))).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ text }] }] });
    expect(r.elementReads).toHaveLength(0);
  });
});

describe('the line of a folded relationship', () => {
  it('carries its member count with its label, under the word the answers repeated', () => {
    const base = expandResult();
    if (base.templateId !== 'expand') throw new Error('an expansion');
    const [from, to] = [nodeOf('A-1').ref, nodeOf('A-2').ref];
    const folded = { ref: { sourceId: from.sourceId, aggregate: { type: V.links[1], from, to } }, from, to, type: V.links[1], direction: 'out', semantics: 'stored', memberCount: { quality: 'lowerBound', value: 1, scope: 'test' }, properties: [], evidenceRefs: [], qualityFlags: [] };
    const result = askRunResultSchema.parse({ ...base, result: { ...base.result, edges: [folded] } });
    const line = [...assembleResults([{ tool: 'shared', result }]).assembled.lines.values()].find((found) => found.includes('members'));
    expect(line).toContain('members: ≥ 1 (lower bound)');
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
