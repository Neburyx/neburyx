import type { Count, GraphEdge, GraphNode, SummaryReading } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { parseStoredEntry, rebuildEntry, refsOf, type StoredEntry } from './notes-rebuild.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const W1 = ref('widget', 'W-1');
const W2 = ref('widget', 'W-2');
const node = (r: ReturnType<typeof ref>, title: string): GraphNode => ({ ref: r, display: { title, type: r.entityType }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const aggregateRef = { sourceId: 'demo', aggregate: { type: 'USES', from: W1, to: W2 } };
const edge = (count: Count | undefined, observedAt?: string): GraphEdge => ({ ref: aggregateRef, ...(count === undefined ? {} : { memberCount: count }), from: W1, to: W2, type: 'USES', direction: 'from-to', semantics: 'stored', ...(observedAt === undefined ? {} : { observedAt }), properties: [], evidenceRefs: [], qualityFlags: [] });
const reading = (nodes: GraphNode[], edges: GraphEdge[]): SummaryReading => ({ nodes, edges, unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
const count = (quality: Count['quality'], value?: number): Count => ({ quality, ...(value === undefined ? {} : { value }), scope: 's' });

const entry = (): StoredEntry => ({
  tokenId: 'tok-1',
  generatedBy: 'person-1',
  modelRef: 'model',
  promptId: 'case-summary',
  promptVersion: '1',
  generatedAt: '2026-11-15T10:00:00.000Z',
  wordListVersion: 2,
  label: 'AI-drafted',
  inputRefs: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }, { key: 'n3', kind: 'entity', ref: ref('widget', 'W-3') }, { key: 'e1', kind: 'relationship', ref: aggregateRef }],
  sentences: [
    { text: '‹widget#1› is linked to ‹widget#2›.', placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: W1 } }, { name: '‹widget#2›', descriptor: { kind: 'entity', ref: W2 } }], cites: [{ key: 'n1', kind: 'entity', ref: W1 }, { key: 'n2', kind: 'entity', ref: W2 }] },
    { text: 'The relationship shows ‹count#1› items.', placeholders: [{ name: '‹count#1›', descriptor: { kind: 'count', relationship: aggregateRef, scope: 'members' } }], cites: [{ key: 'e1', kind: 'relationship', ref: aggregateRef }] },
    { text: 'The link was recorded ‹time#1›.', placeholders: [{ name: '‹time#1›', descriptor: { kind: 'time', relationship: aggregateRef, field: 'observedAt' } }], cites: [{ key: 'e1', kind: 'relationship', ref: aggregateRef }] },
  ],
});

const texts = (rebuilt: ReturnType<typeof rebuildEntry>): string[] => rebuilt.sentences.map((sentence) => sentence.text);
const ANA = node(W1, 'Ana Silva');
const BO = node(W2, 'Bo Chen');

describe('rebuilding a stored sentence for a viewer', () => {
  it('resolves entity, count and time slots from the viewer\'s own reading, with their own titles and quality label', () => {
    const rebuilt = rebuildEntry(entry(), reading([ANA, BO], [edge(count('estimated', 48), '2026-03-04T10:00:00Z')]));
    expect(texts(rebuilt)).toEqual(['Ana Silva is linked to Bo Chen.', 'The relationship shows ~48 (estimated) items.', 'The link was recorded 2026-03-04T10:00:00Z.']);
    expect(rebuilt).toMatchObject({ tokenId: 'tok-1', modelRef: 'model', generatedAt: '2026-11-15T10:00:00.000Z', label: 'AI-drafted' });
    expect(rebuilt.sentences[0]?.citations).toEqual([{ kind: 'entity', ref: W1, title: 'Ana Silva', type: 'widget' }, { kind: 'entity', ref: W2, title: 'Bo Chen', type: 'widget' }]);
  });

  it('shows another viewer their own quality label for the same count, and the masked title they are shown', () => {
    const rebuilt = rebuildEntry(entry(), reading([node(W1, 'A••• S•••'), BO], [edge(count('lowerBound', 50), '2026-03-04T10:00:00Z')]));
    expect(texts(rebuilt)).toEqual(['A••• S••• is linked to Bo Chen.', 'The relationship shows ≥ 50 (lower bound) items.', 'The link was recorded 2026-03-04T10:00:00Z.']);
  });

  it('counts, for each entry, the elements it was made from that the viewer is shown, and notes what access left out', () => {
    expect(rebuildEntry(entry(), reading([ANA, BO], [edge(count('exact', 3))])).coverage).toBe('3 of 4 elements this summary was made from are shown to you');
    expect(rebuildEntry(entry(), { ...reading([ANA], []), omitted: true }).coverage).toBe('1 of 4 elements this summary was made from are shown to you · Some items may be hidden by your access.');
  });

  it('drops, silently, a sentence that cites or names an element the viewer cannot see', () => {
    const rebuilt = rebuildEntry(entry(), reading([ANA], [edge(count('exact', 3), '2026-03-04T10:00:00Z')]));
    expect(texts(rebuilt)).toEqual(['The relationship shows 3 (exact) items.', 'The link was recorded 2026-03-04T10:00:00Z.']);
  });

  it('drops a sentence whose count is unknown for the viewer, or whose time field they do not have', () => {
    expect(texts(rebuildEntry(entry(), reading([ANA, BO], [edge(count('unknown'), '2026-03-04T10:00:00Z')])))).toEqual(['Ana Silva is linked to Bo Chen.', 'The link was recorded 2026-03-04T10:00:00Z.']);
    expect(texts(rebuildEntry(entry(), reading([ANA, BO], [edge(count('exact', 3))])))).toEqual(['Ana Silva is linked to Bo Chen.', 'The relationship shows 3 (exact) items.']);
  });

  it('returns an entry with no sentences when every sentence is dropped, with nothing that says why', () => {
    const rebuilt = rebuildEntry(entry(), reading([], []));
    expect(rebuilt.sentences).toEqual([]);
    expect(JSON.stringify(rebuilt)).not.toMatch(/removed|dropped|hidden/i);
  });

  it('gives the type name of a type placeholder as the viewer\'s profile gives it', () => {
    const typed: StoredEntry = { ...entry(), sentences: [{ text: 'The ‹type#1› is listed.', placeholders: [{ name: '‹type#1›', descriptor: { kind: 'type', of: { kind: 'entity', ref: W1 } } }], cites: [] }] };
    expect(texts(rebuildEntry(typed, reading([node(W1, 'Ana Silva')], [])))).toEqual(['The widget is listed.']);
  });
});

describe('the references of the notes and what is trusted of a stored value', () => {
  it('lists every element an entry cites or names once, by kind, for one batch', () => {
    const refs = refsOf([entry(), entry()]);
    expect(refs.entities).toEqual([W1, W2, ref('widget', 'W-3')]);
    expect(refs.aggregates).toEqual([aggregateRef]);
    expect(refs.edges).toEqual([]);
    expect(refs.derived).toEqual([]);
  });

  it('accepts an entry of this shape and leaves out a stored value that is not', () => {
    expect(parseStoredEntry(JSON.parse(JSON.stringify(entry())))).toEqual(entry());
    expect(parseStoredEntry({ ...entry(), sentences: [{ text: 'x', placeholders: [{ name: '‹a#1›', descriptor: { kind: 'entity', ref: 'nope' } }], cites: [] }] })).toBeUndefined();
    expect(parseStoredEntry({ ...entry(), tokenId: 3 })).toBeUndefined();
    expect(parseStoredEntry({ ...entry(), generatedAt: 'yesterday' })).toBeUndefined();
    expect(parseStoredEntry({ ...entry(), inputRefs: undefined })).toBeUndefined();
    expect(parseStoredEntry('text')).toBeUndefined();
    expect(parseStoredEntry({ ...entry(), sentences: 'no' })).toBeUndefined();
  });
});

describe('value and tally slots for a viewer', () => {
  const withTier = (r: ReturnType<typeof ref>, title: string, value: unknown, masked = false): GraphNode => ({ ...node(r, title), properties: [{ key: 'tier', value, dataClass: 'text', masked }] });
  const valueEntry = (): StoredEntry => ({
    ...entry(),
    sentences: [{ text: '‹widget#1› is ‹value#1›.', placeholders: [{ name: '‹widget#1›', descriptor: { kind: 'entity', ref: W1 } }, { name: '‹value#1›', descriptor: { kind: 'value', of: [{ kind: 'entity', ref: W1 }, { kind: 'entity', ref: W2 }], key: 'tier' } }], cites: [{ key: 'n1', kind: 'entity', ref: W1 }] }],
  });
  const tallyEntry = (): StoredEntry => ({
    ...entry(),
    sentences: [{ text: 'Ana Silva owns ‹count#1›.', placeholders: [{ name: '‹count#1›', descriptor: { kind: 'tally', of: [W1, W2], suffix: 's' } }], cites: [{ key: 'n1', kind: 'entity', ref: W1 }] }],
  });

  it('rebuilds a value from the viewer\'s own reading, showing the masked value they are given and never a stored one', () => {
    expect(texts(rebuildEntry(valueEntry(), reading([withTier(W1, 'Ana Silva', 'gold'), withTier(W2, 'Bo Chen', 'gold')], [])))).toEqual(['Ana Silva is gold.']);
    expect(texts(rebuildEntry(valueEntry(), reading([withTier(W1, 'Ana Silva', 'g•••', true), withTier(W2, 'Bo Chen', 'g•••', true)], [])))).toEqual(['Ana Silva is g•••.']);
    expect(JSON.stringify(valueEntry())).not.toContain('gold');
  });

  it('drops the sentence when an owner is hidden from the viewer, the property is absent, the owners now differ or the value is not a scalar', () => {
    expect(texts(rebuildEntry(valueEntry(), reading([withTier(W1, 'Ana Silva', 'gold')], [])))).toEqual([]);
    expect(texts(rebuildEntry(valueEntry(), reading([ANA, BO], [])))).toEqual([]);
    expect(texts(rebuildEntry(valueEntry(), reading([withTier(W1, 'Ana Silva', 'gold'), withTier(W2, 'Bo Chen', 'silver')], [])))).toEqual([]);
    expect(texts(rebuildEntry(valueEntry(), reading([withTier(W1, 'Ana Silva', ['gold']), withTier(W2, 'Bo Chen', ['gold'])], [])))).toEqual([]);
  });

  it('rebuilds a tally as the count of the elements shown with the type word and its ending, and drops it when one is hidden or the types differ', () => {
    expect(texts(rebuildEntry(tallyEntry(), reading([ANA, BO], [])))).toEqual(['Ana Silva owns 2 widgets.']);
    expect(texts(rebuildEntry(tallyEntry(), reading([ANA], [])))).toEqual([]);
    expect(texts(rebuildEntry(tallyEntry(), reading([ANA, { ...BO, display: { title: 'Bo Chen', type: 'gadget' } }], [])))).toEqual([]);
  });

  it('asks for the elements of value and tally slots in the one batch', () => {
    const refs = refsOf([valueEntry(), tallyEntry()]);
    expect(refs.entities.map((r) => r.stableId).sort()).toEqual(['W-1', 'W-2', 'W-3']);
  });
});
