import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ASSISTANT_TABLE_SELECT_SENTENCE, pluralOf, readAnswerSchema, tableNote, tableTitle, tableUnitClause, type ReadAnswer, type SourceProfile } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { testProfile } from '../dev/test-profile.js';
import { ASSISTANT_COPY } from './copy.js';
import { captionOf, noteOf, storedViewOf } from './stored-answer.js';

const PACKS = ['banking-fraud', 'insurance-claims'] as const;
const REF = { sourceId: 'source-a', entityType: 'x', stableId: 'e1' };

interface Pack {
  readonly profile: SourceProfile;
  readonly type: string;
  readonly name: string;
  /** The property of the type that the mapping gives a unit, with its label and unit; none when the pack gives none. */
  readonly unit: { readonly property: string; readonly label: string; readonly unit: string } | undefined;
}

/** The first entity type of a pack's mapping, its label, and the first property display with a unit, read from the pack's own mapping file: no name of a pack is written here. */
function packOf(directory: string): Pack {
  const mapping = readFileSync(resolve(process.cwd(), '../../domain-packs', directory, 'neburyx.yaml'), 'utf8');
  const withUnit = /^\s+- type: (\S+)\n\s+label: (\S+)\n(?:.*\n)*?\s+property_display: \{ (\w+): \{ label: (\w+), unit: (\w+) \} \}/m.exec(mapping);
  const first = { type: /^\s+- type: (\S+)$/m.exec(mapping)?.[1] ?? '', name: /^\s+label: (\S+)$/m.exec(mapping)?.[1] ?? '' };
  const type = withUnit?.[1] ?? first.type;
  const name = withUnit?.[2] ?? first.name;
  expect(type).not.toBe('');
  const base = testProfile('source-a', [type]);
  const entry = base.entityTypes[0];
  if (entry === undefined) throw new Error('no entity type');
  const unit = withUnit === null ? undefined : { property: withUnit[3] ?? '', label: withUnit[4] ?? '', unit: withUnit[5] ?? '' };
  const shown = { ...entry, displayName: name, ...(unit === undefined ? {} : { propertyDisplay: { [unit.property]: { label: unit.label, unit: unit.unit } } }) };
  return { profile: { ...base, entityTypes: [shown] }, type, name, unit };
}

const table = (over: Record<string, unknown> = {}): ReadAnswer => readAnswerSchema.parse({
  blocks: [{ kind: 'table', columns: [{ state: 'text', text: 'Name' }, { state: 'text', text: 'Size' }], rows: [{ cells: [{ state: 'text', text: 'Ana' }, { state: 'text', text: '4,200' }], cites: [REF] }, { cells: [{ state: 'text', text: 'Bo' }, { state: 'text', text: '80' }], cites: [REF] }], ...over }],
});
const drawn = (answer: ReadAnswer, profile: SourceProfile | undefined) => {
  const view = storedViewOf(answer, () => undefined, profile);
  const block = view.blocks[0];
  if (block?.kind !== 'table') throw new Error('not a table');
  return block.table;
};

describe('the caption, the note and the notices of a table opened again from the thread', () => {
  const packs = PACKS.map(packOf);

  it('reads a unit from at least one pack, so that the clause of a unit is tested', () => {
    expect(packs.some((pack) => pack.unit !== undefined)).toBe(true);
  });

  it.each(PACKS.map((directory, index) => [directory, index] as const))('writes the title with the display name of the type and the anchor, and the note with the unit the mapping gives, as the live card does (%s)', (_name, index) => {
    const pack = packs[index];
    if (pack === undefined) throw new Error('no pack');
    const units = pack.unit === undefined ? [] : [{ type: pack.type, property: pack.unit.property }];
    const answer = table({ caption: { subject: pack.type, anchor: { state: 'text', text: 'Jordan Lee' } }, units, droppedRows: 2, moreNotShown: 5 });
    const shown = drawn(answer, pack.profile);
    // the live card's words are written by the rules of the contract with the same facts
    expect(shown.title).toBe(tableTitle(pluralOf(pack.name), 2, 'Jordan Lee'));
    expect(shown.note).toBe(tableNote(pack.unit === undefined ? [] : [tableUnitClause(pack.unit.label, pack.unit.property, pack.unit.unit)]));
    expect(shown).toMatchObject({ droppedRows: 2, moreNotShown: 5 });
  });

  it.each(PACKS.map((directory, index) => [directory, index] as const))('says nothing of the other pack: the words are the mapping\'s of the source (%s)', (_name, index) => {
    const pack = packs[index];
    const other = packs[1 - index];
    if (pack === undefined || other === undefined) throw new Error('no pack');
    const shown = drawn(table({ caption: { subject: pack.type } }), pack.profile);
    expect(shown.title).toBe(`${pluralOf(pack.name)} · 2 rows`);
    if (other.name !== pack.name) expect(`${shown.title} ${shown.note}`).not.toContain(other.name);
  });

  it('draws the neutral plural, never the key, when the type is no longer in the mapping or the rows were about several types', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    expect(drawn(table({ caption: { subject: 'gone-type' } }), pack.profile).title).toBe('Elements · 2 rows');
    expect(drawn(table({ caption: {} }), pack.profile).title).toBe('Elements · 2 rows');
    expect(drawn(table({ caption: { subject: pack.type } }), undefined).title).toBe('Elements · 2 rows');
  });

  it('draws an ellipsis for an anchor that the read withheld, and no clause for a unit the mapping no longer gives', () => {
    const pack = packs[0];
    if (pack === undefined) throw new Error('no pack');
    const answer = table({ caption: { subject: pack.type, anchor: { state: 'withheld' } }, units: [{ type: pack.type, property: 'removed-property' }, { type: 'gone-type', property: 'removed-property' }] });
    const shown = drawn(answer, pack.profile);
    expect(shown.title).toBe(tableTitle(pluralOf(pack.name), 2, ASSISTANT_COPY.storedAnchorWithheld));
    expect(shown.note).toBe(ASSISTANT_TABLE_SELECT_SENTENCE);
  });

  it('draws a table stored before the caption was kept with the count of the rows it holds and the fixed sentence, and no notice', () => {
    const shown = drawn(table(), packs[0]?.profile);
    expect(shown.title).toBe('2 rows');
    expect(shown.note).toBe(ASSISTANT_TABLE_SELECT_SENTENCE);
    expect(shown).not.toHaveProperty('droppedRows');
    expect(shown).not.toHaveProperty('moreNotShown');
  });

  it('gives a title that counts one row in the singular', () => {
    const answer = readAnswerSchema.parse({ blocks: [{ kind: 'table', caption: {}, columns: [{ state: 'text', text: 'Name' }], rows: [{ cells: [{ state: 'text', text: 'Ana' }], cites: [REF] }] }] });
    const block = answer.blocks[0];
    if (block?.kind !== 'table') throw new Error('not a table');
    expect(captionOf(block, undefined)).toBe('Elements · 1 row');
    expect(noteOf(block, undefined)).toBe(ASSISTANT_TABLE_SELECT_SENTENCE);
  });
});
