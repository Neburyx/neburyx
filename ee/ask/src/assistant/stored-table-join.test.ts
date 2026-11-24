import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AIMessage, fakeModel } from '@neburyx/ee-assistant-agent/testing';
import { ASSISTANT_TABLE_ANCHOR_WITHHELD, pluralOf, assistantThreadResponseSchema, assistantThreadTurnWriteSchema, tablesOfBlocks, type AssistantTurnAnswer, type StoredTurnText } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { BODY, VIEW_BODY, V, answerOf, expandResult, nodeOf, ok, rig } from '../testing/assistant-rig.js';
import { storedAnswerOf } from './thread-answer.js';
import { presentThread } from './thread-present.js';
import type { AssistantThreadRead } from './thread-store.js';

/**
 * One card, two sides. The server writes a table through the real route, stores it, and reads it back through the real stored read; the web draws the reopened card from the read with the mapping. This test produces the cases and writes them to a
 * fixture that the web's test draws from, comparing what it draws with what the live card said; this test fails when the fixture on disk is not what the server produces now, so neither side can drift alone. `UPDATE_FIXTURES=1` rewrites it.
 */
const FIXTURE = fileURLToPath(new URL('../../../../packages/contracts/fixtures/stored-table-cards.json', import.meta.url));
const PROPERTY = 'sizeUsd';
const DISPLAY = { [PROPERTY]: { label: 'size', unit: 'USD' } };
/** The plain-words name the mapping gives the type: not its key, so that a card that writes the key as the name is told apart. */
const DISPLAY_NAME = 'Holding record';
const TABLE = ok('{"route":"view","form":"table"}');
const VERSION = 'sv1:join';

const withSize = (id: string, value: number): ReturnType<typeof nodeOf> => ({ ...nodeOf(id, `${V.title} ${id}`), properties: [{ key: PROPERTY, value, dataClass: 'number', masked: false }] }) as unknown as ReturnType<typeof nodeOf>;
const keysOf = (nodes: ReturnType<typeof nodeOf>[]) => nodes.map((node) => JSON.stringify(['node', node.ref.sourceId, node.ref.entityType, node.ref.stableId]));

/** The live answer of a route: the table block the server wrote. */
async function live(script: ReturnType<typeof fakeModel>, over: { nodes: ReturnType<typeof nodeOf>[]; expand?: boolean }) {
  const r = await rig({ reply: TABLE, agent: { model: script, maxCalls: 6, maxInputTokens: 60_000 }, viewNodes: over.nodes, loopSteps: 3, types: [V.anchor], propertyDisplay: DISPLAY, displayNames: { [V.anchor]: DISPLAY_NAME }, ...(over.expand === true ? { run: () => ({ status: 'ok', result: expandResult() }) } : {}) });
  const answer = await answerOf(r.route.handler(r.request({ ...BODY, viewElementKeys: keysOf(over.nodes) })));
  if (answer.status !== 'answered' || !('blocks' in answer)) throw new Error(`not a table answer: ${JSON.stringify(answer).slice(0, 160)}`);
  const table = tablesOfBlocks(answer.blocks)[0];
  if (table === undefined) throw new Error('no table');
  return { answer, table };
}

const stored = (answer: AssistantTurnAnswer, maskOn: boolean): StoredTurnText => {
  const kept = storedAnswerOf(answer, maskOn);
  if (kept === undefined) throw new Error('no stored form');
  return { question: 'Q?', maskOn, answer: assistantThreadTurnWriteSchema.shape.answer.unwrap().parse(kept.answer), sensitivityVersion: VERSION };
};
const readOf = (text: StoredTurnText, maskNow: boolean, version = VERSION) => {
  const thread: AssistantThreadRead = { turns: [{ id: '0192f000-0000-7000-8000-0000000000f1', seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'view', outcome: 'answered', citedElements: 1, steps: 0, stored: text }], earlierTurns: 0, previousThreadClearedAt: null, epoch: 0 };
  const shown = assistantThreadResponseSchema.parse(presentThread(thread, maskNow, version));
  const block = shown.turns[0]?.answer?.blocks.find((entry) => entry.kind === 'table');
  if (block === undefined) throw new Error('no table in the read');
  return block;
};

async function cases() {
  const one = [withSize('A-1', 4200), withSize('A-2', 80)];
  const unit = await live(
    fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element', 'Size'], rows: [{ cells: [`${V.title} A-1`, '4,200'], cites: ['n1'] }, { cells: [`${V.title} A-2`, '80'], cites: ['n2'] }, { cells: [`${V.title} Z-9`, '1'], cites: ['n9'] }] }] } }])
      .respond(new AIMessage('Done.')),
    { nodes: one },
  );
  const anchored = await live(
    fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'expand', args: { entityType: V.anchor, stableId: 'A-1', neighborType: V.anchor } }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: [{ cells: [`${V.title} A-2`], cites: ['n2'] }, { cells: [`${V.title} A-3`], cites: ['n3'] }] }] } }])
      .respond(new AIMessage('Done.')),
    { nodes: ['A-1', 'A-2', 'A-3'].map((id) => nodeOf(id, `${V.title} ${id}`)), expand: true },
  );
  const many = await live(
    fakeModel()
      .respondWithTools([{ name: 'view', args: {} }])
      .respondWithTools([{ name: 'answer', args: { blocks: [{ kind: 'table', columns: ['Element'], rows: Array.from({ length: 27 }, () => ({ cells: [`${V.title} A-1`], cites: ['n1'] })) }] } }])
      .respond(new AIMessage('Done.')),
    { nodes: one },
  );
  return { unit, anchored, many };
}

/** The type of the mapping the cards were written under, as the web's profile holds it. */
const profile = (types: readonly string[]) => ({ entityTypes: types.map((type) => ({ type, displayName: DISPLAY_NAME, propertyDisplay: DISPLAY })) });

// the fixture is made under the invented vocabulary of the suites: with a pack named for the other suites it is not this test's to make
describe.skipIf(process.env['NEBURYX_TEST_PACK'] !== undefined && process.env['NEBURYX_TEST_PACK'] !== '')('a stored table read back, and the same card drawn by the web', () => {
  it('writes the live cards through the real route and the real stored read, and the fixture of the web holds exactly what they say', async () => {
    const { unit, anchored, many } = await cases();
    const swap = (title: string, from: string, to: string): string => title.replace(from, to);
    const plural = (title: string): string => title.split(' · ')[0]?.split(' of ')[0] ?? '';
    const cards = [
      // mask off at the write and the read, a unit, a row left out
      { name: 'unmasked, a unit and a row left out', read: readOf(stored(unit.answer, false), false), profile: profile([V.anchor]), expected: { title: unit.table.title, note: unit.table.note, droppedRows: unit.table.droppedRows } },
      // mask on at the write and at the read: the anchor was kept as shown
      { name: 'masked at the write, the anchor as shown', read: readOf(stored(anchored.answer, true), true), profile: profile([V.anchor]), expected: { title: anchored.table.title, note: anchored.table.note } },
      // written unmasked, the mask turned on after: the anchor is withheld
      { name: 'unmasked at the write, masked after: the anchor withheld', read: readOf(stored(anchored.answer, false), true), profile: profile([V.anchor]), expected: { title: anchored.table.anchor === undefined ? '' : swap(anchored.table.title, anchored.table.anchor, ASSISTANT_TABLE_ANCHOR_WITHHELD), note: anchored.table.note } },
      // the type is gone from the mapping
      { name: 'the type gone from the mapping', read: readOf(stored(anchored.answer, true), true), profile: profile([]), expected: { title: swap(anchored.table.title, plural(anchored.table.title), 'Elements'), note: anchored.table.note } },
      // the version of the mapping's sensitivity is not the one the card was written under: the anchor is withheld under the mask, though it was kept as shown
      { name: 'the sensitivity version changed: the anchor withheld', read: readOf(stored(anchored.answer, true), true, 'sv1:changed'), profile: profile([V.anchor]), expected: { title: anchored.table.anchor === undefined ? '' : swap(anchored.table.title, anchored.table.anchor, ASSISTANT_TABLE_ANCHOR_WITHHELD), note: anchored.table.note } },
      // rows beyond the limit
      { name: 'rows not shown', read: readOf(stored(many.answer, false), false), profile: profile([V.anchor]), expected: { title: many.table.title, note: many.table.note, moreNotShown: many.table.moreNotShown } },
    ];
    // what the live cards say is what the cases expect, and every notice that has to be there is there
    expect(unit.table).toMatchObject({ droppedRows: 1, subject: V.anchor });
    // the live title says the plural of the display name, never the key
    expect(unit.table.title).toBe(`${pluralOf(DISPLAY_NAME)} · 2 rows`);
    expect(unit.table.title).not.toContain(V.anchor);
    expect(unit.table.note).toContain('Size in USD.');
    expect(anchored.table.anchor).toBeDefined();
    expect(many.table.moreNotShown).toBeGreaterThan(0);
    const fixture = `${JSON.stringify({ cards }, null, 2)}\n`;
    if (process.env['UPDATE_FIXTURES'] === '1') writeFileSync(FIXTURE, fixture);
    expect(readFileSync(FIXTURE, 'utf8')).toBe(fixture);
  });
});
