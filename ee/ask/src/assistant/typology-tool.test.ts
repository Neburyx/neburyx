import { sentencesOfBlocks, type AssistantBlocks } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { removeAskFolders } from '../testing/ask-folder.js';
import { BODY, answerOf, ok, rig, routeAsk, type Rig } from '../testing/assistant-rig.js';
import { buildToolRegistry, TYPOLOGY_TOOL } from './tool-registry.js';
import { assembleResults } from './tool-answer.js';
import { typologyLinesOf } from './view-instructions.js';
import { TURN_CLOSED_ACTION } from './turn-audit.js';
import type { FixtureReply } from '../../../ai-runtime/src/testing/fixture.js';

afterAll(removeAskFolders);

const LINES = ['Fan-in: many sources send money to one receiver.', 'Cycle: money leaves an account and returns to it.'];
const SHARED = routeAsk('shared', { id: 'A-1' });
const TYPOLOGY = ok('{"tool":"typology","values":{}}');
const DONE = ok('{"done":true}');
const sentences = (...list: { text: string; cites: string[] }[]) => ok(JSON.stringify({ sentences: list }));
const sequence = (...replies: FixtureReply[]) => {
  let next = 0;
  return () => replies[Math.min(next++, replies.length - 1)] ?? DONE;
};
const registryWith = (typology?: readonly string[], intents: readonly { name: string }[] = []) =>
  buildToolRegistry({ source: { intents: intents.map((intent) => ({ name: intent.name, parameters: [], kind: 'query' })) } as never, patterns: undefined, viewReadable: false, templateRunnable: () => true, ...(typology === undefined ? {} : { typology }) });
const turnOf = (r: Rig) => (r.events.find((event) => event.action === TURN_CLOSED_ACTION)?.detail as { turn: Record<string, unknown> }).turn;

describe('the typology in the registry', () => {
  it('is a tool of its own kind with no values when the list has an item, and absent otherwise', () => {
    expect(registryWith(LINES).find(TYPOLOGY_TOOL)).toMatchObject({ name: 'typology', kind: 'typology', parameters: [], available: true });
    expect(registryWith([]).find(TYPOLOGY_TOOL)).toBeUndefined();
    expect(registryWith().find(TYPOLOGY_TOOL)).toBeUndefined();
  });

  it('leaves the name to a folder intent of the same name', () => {
    expect(registryWith(LINES, [{ name: 'typology' }]).find('typology')?.kind).toBe('intent');
  });

});

describe('the lines of the typology file', () => {
  it('are the items of its list, never its heading or its paragraph', () => {
    expect(typologyLinesOf('# Shapes\n\nThese are structures.\n\n- Fan-in: many.\n- Cycle: back.\n-\n- \n')).toEqual(['Fan-in: many.', 'Cycle: back.']);
    expect(typologyLinesOf('# Only a heading\n\nand a paragraph')).toEqual([]);
  });
});

describe('the answer lines of the typology', () => {
  it('gives each line a key t1, t2, … that is no element, and a read line saying how many lines', () => {
    const { assembled, readKeys } = assembleResults([{ tool: 'typology', typology: LINES }]);
    expect(assembled.lines.get('t1')).toBe(`t1: ${LINES[0]}`);
    expect(assembled.lines.get('t2')).toBe(`t2: ${LINES[1]}`);
    expect(assembled.lines.get('s1')).toBe('s1: read of typology: 2 lines');
    expect(readKeys).toEqual(['s1', 't1', 't2']);
    expect([...assembled.keys.keys()]).toEqual([]);
  });
});

describe('a turn that reads the typology', () => {
  const turn = (answer: FixtureReply) => rig({ reply: SHARED, step: sequence(TYPOLOGY, DONE), answer, typology: LINES });

  it('reads nothing from the source, lists a read of its own kind with its lines and no rows, and keeps a sentence that cites a line it returned', async () => {
    const r = await turn(sentences({ text: 'A fan-in is when many sources send money to one receiver.', cites: ['t1'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    // the one run is the router's own ask read; the typology step reads nothing from the source
    expect(r.runs).toHaveLength(1);
    expect(answer).toMatchObject({ status: 'answered', route: 'ask', steps: 2, blocks: [{ kind: 'sentences', sentences: [{ cites: ['t1'] }] }] });
    const reads = (answer as { reads?: readonly Record<string, unknown>[] }).reads ?? [];
    expect(reads.find((entry) => entry['kind'] === 'typology')).toMatchObject({ tool: 'typology', read: true, lines: 2, quality: 'exact', partial: false });
    expect(reads.find((entry) => entry['kind'] === 'typology')).not.toHaveProperty('rows');
    expect(turnOf(r)).toMatchObject({ steps: 2 });
  });

  it('shows the model each line with its key, and drops a sentence that cites a typology line it was not given or any key the turn does not hold', async () => {
    const r = await turn(sentences({ text: 'A fan-in is when many sources send money to one receiver.', cites: ['t1'] }, { text: 'A cycle is shown.', cites: ['t9'] }, { text: 'Something else.', cites: ['n1'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', blocks: [{ kind: 'sentences', sentences: [{ cites: ['t1'] }] }] });
    expect(sentencesOfBlocks((answer as { blocks: AssistantBlocks }).blocks)).toHaveLength(1);
  });

  it('shows a sentence that cites only typology lines with no source chips', async () => {
    const r = await turn(sentences({ text: 'A fan-in is when many sources send money to one receiver.', cites: ['t1'] }));
    const answer = await answerOf(r.route.handler(r.request()));
    expect(answer).toMatchObject({ status: 'answered', citations: [] });
  });

});
