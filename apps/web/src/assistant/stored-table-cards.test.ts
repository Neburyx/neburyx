import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readAnswerSchema, type SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { storedViewOf } from './stored-answer.js';

/**
 * The cards the server wrote through its real route, stored and read back through its real stored read (the test of `ee/ask` that makes this file and fails when it is not what the server produces now). The web draws each reopened card from the read and the mapping
 * and must say what the live card said: its caption, its note and its notices.
 */
interface Card {
  readonly name: string;
  readonly read: unknown;
  readonly profile: { readonly entityTypes: readonly { readonly type: string; readonly displayName: string; readonly propertyDisplay: Record<string, { label?: string; unit?: string }> }[] };
  readonly expected: { readonly title: string; readonly note: string; readonly droppedRows?: number; readonly moreNotShown?: number };
}

const cards = (JSON.parse(readFileSync(resolve(process.cwd(), '../../packages/contracts/fixtures/stored-table-cards.json'), 'utf8')) as { cards: Card[] }).cards;

const profileOf = (card: Card): SourceProfile => {
  const base = testProfile('source-a', card.profile.entityTypes.map((entry) => entry.type));
  return { ...base, entityTypes: base.entityTypes.map((entry, index) => ({ ...entry, displayName: card.profile.entityTypes[index]?.displayName ?? entry.displayName, propertyDisplay: card.profile.entityTypes[index]?.propertyDisplay ?? {} })) };
};

describe('the cards the server stored, drawn again by the web as the live card said them', () => {
  it('has the cases the server makes: masked and unmasked at the write, the mask turned on after, the type gone, rows left out and not shown', () => {
    expect(cards.map((card) => card.name)).toEqual([
      'unmasked, a unit and a row left out',
      'masked at the write, the anchor as shown',
      'unmasked at the write, masked after: the anchor withheld',
      'the type gone from the mapping',
      'the sensitivity version changed: the anchor withheld',
      'rows not shown',
    ]);
    expect(cards.some((card) => card.expected.droppedRows !== undefined)).toBe(true);
    expect(cards.some((card) => card.expected.moreNotShown !== undefined)).toBe(true);
  });

  it.each(cards.map((card) => [card.name, card] as const))('draws the caption, the note and the notices of: %s', (_name, card) => {
    const answer = readAnswerSchema.parse({ blocks: [card.read] });
    const view = storedViewOf(answer, () => undefined, profileOf(card));
    const block = view.blocks[0];
    if (block?.kind !== 'table') throw new Error('not a table');
    expect(block.table.title).toBe(card.expected.title);
    expect(block.table.note).toBe(card.expected.note);
    expect(block.table.droppedRows).toBe(card.expected.droppedRows);
    expect(block.table.moreNotShown).toBe(card.expected.moreNotShown);
  });
});
