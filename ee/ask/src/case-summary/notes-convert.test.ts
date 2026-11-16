import type { Count, GraphEdge, GraphNode, SummaryReading, SummarySentence } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { assembleText } from './assemble.js';
import { templatesOf, type NotesTemplate } from './notes-convert.js';

const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
const node = (stableId: string, title: string, entityType = 'widget', value = 'gold'): GraphNode => ({ ref: ref(entityType, stableId), display: { title, type: entityType }, properties: [{ key: 'tier', value, dataClass: 'text', masked: false }], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const reading = (nodes: GraphNode[], edges: GraphEdge[] = []): SummaryReading => ({ nodes, edges, unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
const sentence = (text: string, ...cites: string[]): SummarySentence => ({ text, cites });

function convert(sentences: SummarySentence[], nodes: GraphNode[] = [node('W-1', 'Ana Silva'), node('W-2', 'Bo Chen')], edges: GraphEdge[] = []): readonly NotesTemplate[] {
  const given = reading(nodes, edges);
  return templatesOf(sentences, assembleText(given), given);
}

const W1 = ref('widget', 'W-1');
const W2 = ref('widget', 'W-2');
const aggregate = (type: string, count: Count | undefined, times: Partial<GraphEdge> = {}): GraphEdge => ({
  ref: { sourceId: 'demo', aggregate: { type, from: W1, to: W2 } },
  ...(count === undefined ? {} : { memberCount: count }),
  from: W1,
  to: W2,
  type,
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
  ...times,
});
const stored = (id: string, times: Partial<GraphEdge>): GraphEdge => ({ ref: { sourceId: 'demo', type: 'USES', from: 'widget', to: 'widget', stableId: id }, from: W1, to: W2, type: 'USES', direction: 'from-to', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [], ...times });
const exact = (value: number): Count => ({ quality: 'exact', value, scope: 's' });
/** The key the assembled text gives an edge, so a sentence can cite it. */
const keyOf = (edges: GraphEdge[], edge: GraphEdge): string => [...assembleText(reading([node('W-1', 'Ana Silva'), node('W-2', 'Bo Chen')], edges)).keys].find(([, element]) => element.kind === 'relationship' && JSON.stringify(element.ref) === JSON.stringify(edge.ref))?.[0] ?? '';

const reasonOf = (template: NotesTemplate | undefined): string | undefined => (template === undefined || template.storable ? undefined : template.reason);
const textOf = (template: NotesTemplate | undefined): string | undefined => (template?.storable === true ? template.text : undefined);

describe('entity and type placeholders', () => {
  it('stores the title and the stable id of a cited entity as an entity placeholder, with a descriptor that names the entity', () => {
    const [only] = convert([sentence('Ana Silva is linked to W-2.', 'n1', 'n2')]);
    expect(textOf(only)).toBe('‹widget#1› is linked to ‹widget#2›.');
    expect(only?.storable && only.placeholders).toEqual([
      { name: '‹widget#1›', descriptor: { kind: 'entity', ref: ref('widget', 'W-1') } },
      { name: '‹widget#2›', descriptor: { kind: 'entity', ref: ref('widget', 'W-2') } },
    ]);
  });

  it('gives one entity one name in every sentence of the draft', () => {
    const [first, second] = convert([sentence('Ana Silva is linked.', 'n1'), sentence('Bo Chen is linked to Ana Silva.', 'n1', 'n2')]);
    expect(textOf(first)).toBe('‹widget#1› is linked.');
    expect(textOf(second)).toBe('‹widget#2› is linked to ‹widget#1›.');
  });

  it('stores the type name of a cited element as a type placeholder, whatever the name holds', () => {
    const [only] = convert([sentence('The tier-2 is linked to Ana Silva.', 'n1')], [node('W-1', 'Ana Silva', 'tier-2')]);
    expect(textOf(only)).toBe('The ‹type#1› is linked to ‹tier-2#1›.');
    expect(only?.storable && only.placeholders.map((placeholder) => placeholder.descriptor.kind)).toEqual(['type', 'entity']);
  });

  it.each([
    ['the name of an element that was sent but not cited', 'Ana Silva is linked to Bo Chen.', ['n1'], 'name'],
    ['a name that is also a listed word, of an element that is not cited', 'The record is linked.', ['n1'], 'name'],
    ['a name only in part', 'Ana is linked.', ['n1'], 'unlisted-word'],
    ['a name with a look-alike character', 'Аna Silva is linked.', ['n1'], 'unlisted-word'],
    ['the name of an uncited element in another case', 'The bo chen is linked to Ana Silva.', ['n1'], 'name'],
    ['the title of an uncited element that is a listed word, in lower case', 'The open is linked.', ['n1'], 'name'],
    ['a placeholder written by the model', 'The ‹widget#1› is linked.', ['n1'], 'unlisted-word'],
  ])('does not store a sentence with %s', (_name, text, cites, reason) => {
    const [only] = convert([sentence(text, ...cites)], [node('W-1', 'Ana Silva'), node('W-2', 'Bo Chen'), node('W-3', 'record'), node('W-4', 'Open')]);
    expect(reasonOf(only)).toBe(reason);
  });

  it('does not store a title that two elements share, because it cannot tell which one the sentence means', () => {
    const [only] = convert([sentence('Ana Silva is linked.', 'n1', 'n2')], [node('W-1', 'Ana Silva'), node('W-2', 'Ana Silva')]);
    expect(reasonOf(only)).toBe('name');
  });

  it('stores a cited name written in another case as the same placeholder', () => {
    expect(textOf(convert([sentence('ANA SILVA is linked.', 'n1')])[0])).toBe('‹widget#1› is linked.');
  });

  it('stores an entity whose title is its own stable id once, and an entity with a numeric id and a numeric property, beside a slot', () => {
    expect(textOf(convert([sentence('W-1 is linked.', 'n1')], [node('W-1', 'W-1')])[0])).toBe('‹widget#1› is linked.');
    const numeric = convert([sentence('The record 0 is linked to Ana Silva.', 'n1', 'n2')], [node('0', '0', 'widget', '0'), node('W-2', 'Ana Silva')]);
    expect(reasonOf(numeric[0])).not.toBe('property-value');
  });

  it('does not store a title that a cited and an uncited element share in different cases', () => {
    const [only] = convert([sentence('Open is linked.', 'n1')], [node('W-1', 'Open'), node('W-2', 'open')]);
    expect(reasonOf(only)).toBe('name');
  });

  it('does not store a property value in another case, or one inside a list', () => {
    const other = node('W-3', 'Cy Park', 'widget', 'silver');
    expect(reasonOf(convert([sentence('Ana Silva is Silver.', 'n1')], [node('W-1', 'Ana Silva'), other])[0])).toBe('property-value');
    const listed: GraphNode = { ...node('W-1', 'Ana Silva'), properties: [{ key: 'tags', value: ['alpha', 'beta'], dataClass: 'list', masked: false }] };
    expect(reasonOf(convert([sentence('Ana Silva has beta.', 'n1')], [listed])[0])).toBe('property-value');
  });

  it('answers the same twice', () => {
    const sentences = [sentence('Ana Silva is linked to Bo Chen.', 'n1', 'n2')];
    expect(convert(sentences)).toEqual(convert(sentences));
  });
});

describe('count slots', () => {
  const usesEdge = aggregate('USES', { quality: 'estimated', value: 48, scope: 's' });
  const own = [usesEdge];

  it('stores the member count phrase of exactly one cited relationship as a count slot bound to it', () => {
    const [only] = convert([sentence('The relationship shows ~48 (estimated) items.', keyOf(own, usesEdge))], undefined, own);
    expect(textOf(only)).toBe('The relationship shows ‹count#1› items.');
    expect(only?.storable && only.placeholders).toEqual([{ name: '‹count#1›', descriptor: { kind: 'count', relationship: usesEdge.ref, scope: 'members' } }]);
    expect(JSON.stringify(only)).not.toContain('48');
  });

  it.each([
    ['a phrase two cited relationships share', () => [aggregate('USES', exact(3)), aggregate('OWNS', exact(3))], 'The links are 3 (exact).', 'number-or-date'],
    ['a phrase no cited relationship has', () => [aggregate('USES', exact(3))], 'The links are 4 (exact).', 'number-or-date'],
    ['a bare number equal to a count', () => [aggregate('USES', exact(3))], 'The links are 3.', 'number-or-date'],
    ['the phrase not known', () => [aggregate('USES', { quality: 'unknown', scope: 's' })], 'The links are not known.', 'number-or-date'],
  ])('does not store %s', (_name, make, text, reason) => {
    const edges = make();
    const [only] = convert([sentence(text, ...edges.map((edge) => keyOf(edges, edge)))], undefined, edges);
    expect(reasonOf(only)).toBe(reason);
  });

  it('does not store the count of a relationship that the sentence does not cite', () => {
    const [only] = convert([sentence('The links are 3 (exact).', 'n1')], undefined, [aggregate('USES', exact(3))]);
    expect(reasonOf(only)).toBe('number-or-date');
  });
});

describe('time slots', () => {
  const when = '2026-03-04T10:00:00Z';

  it.each(['observedAt', 'observedFirst', 'observedLast', 'validFrom', 'validTo'] as const)('stores the %s of exactly one cited relationship as a time slot bound to it and that field', (field) => {
    const edge = stored('L-1', { [field]: when });
    const [only] = convert([sentence(`The link was recorded ${when}.`, keyOf([edge], edge))], undefined, [edge]);
    expect(only?.storable && only.placeholders.map((placeholder) => placeholder.descriptor)).toEqual([{ kind: 'time', relationship: edge.ref, field }]);
    expect(textOf(only)).toBe('The link was recorded ‹time#1›.');
  });

  it('does not store a time that two fields share, one that a property value also holds, or one the sentence writes in another format', () => {
    const shared = stored('L-1', { observedFirst: when, validFrom: when });
    expect(reasonOf(convert([sentence(`The link began ${when}.`, keyOf([shared], shared))], undefined, [shared])[0])).toBe('number-or-date');
    const withProperty = [node('W-1', 'Ana Silva', 'widget', when), node('W-2', 'Bo Chen')];
    const edge = stored('L-2', { observedAt: when });
    expect(reasonOf(convert([sentence(`The link began ${when}.`, keyOf([edge], edge))], withProperty, [edge])[0])).toBe('number-or-date');
    const plain = stored('L-3', { observedAt: when });
    expect(reasonOf(convert([sentence('The link began 4 March 2026.', keyOf([plain], plain))], undefined, [plain])[0])).toBe('number-or-date');
  });

  it('does not store a time of a relationship the sentence does not cite', () => {
    const edge = stored('L-1', { observedAt: when });
    expect(reasonOf(convert([sentence(`The link began ${when}.`, 'n1')], undefined, [edge])[0])).toBe('number-or-date');
  });
});

describe('the bound of a stored sentence', () => {
  it('stores a sentence of 50 cited elements and does not store one of 51, so what is copied can always be read', () => {
    const nodes = Array.from({ length: 51 }, (_, i) => node(`W-${i + 1}`, `Name${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} Silva`));
    const keys = [...assembleText(reading(nodes)).keys.keys()];
    const many = (count: number) => convert([sentence('NameAa Silva', ...keys.slice(0, count))], nodes)[0];
    expect(many(50)?.storable).toBe(true);
    expect(reasonOf(many(51))).toBe('name');
  });
});

describe('value slots', () => {
  const two = [node('W-1', 'Ana Silva', 'widget', 'gold'), node('W-2', 'Bo Chen', 'widget', 'gold')];
  const slotOf = (template: NotesTemplate | undefined) => (template?.storable === true ? template.placeholders.find((placeholder) => placeholder.descriptor.kind === 'value') : undefined);

  it('stores a property value of a cited element as a value slot that names the element and the property, never the value', () => {
    const [only] = convert([sentence('Ana Silva is Gold.', 'n1')], [node('W-1', 'Ana Silva', 'widget', 'gold'), node('W-2', 'Bo Chen', 'widget', 'silver')]);
    expect(textOf(only)).toBe('‹widget#1› is ‹value#1›.');
    expect(slotOf(only)?.descriptor).toMatchObject({ kind: 'value', key: 'tier', of: [{ kind: 'entity', ref: W1 }] });
    expect(JSON.stringify(only)).not.toMatch(/gold/iu);
  });

  it('binds a value that every cited owner holds under one key to all of them', () => {
    const [only] = convert([sentence('Ana Silva and Bo Chen are gold.', 'n1', 'n2')], two);
    expect(textOf(only)).toBe('‹widget#1› and ‹widget#2› are ‹value#1›.');
    expect(slotOf(only)?.descriptor).toMatchObject({ kind: 'value', key: 'tier', of: [{ ref: W1 }, { ref: W2 }] });
  });

  it('does not store a value held under two properties of the cited elements, or a value that only an uncited element holds', () => {
    const twice: GraphNode = { ...node('W-1', 'Ana Silva'), properties: [{ key: 'tier', value: 'gold', dataClass: 'text', masked: false }, { key: 'band', value: 'gold', dataClass: 'text', masked: false }] };
    expect(reasonOf(convert([sentence('Ana Silva is gold.', 'n1')], [twice, node('W-2', 'Bo Chen')])[0])).toBe('property-value');
    expect(reasonOf(convert([sentence('Ana Silva is silver.', 'n1')], [node('W-1', 'Ana Silva'), node('W-2', 'Bo Chen', 'widget', 'silver')])[0])).toBe('property-value');
  });

  it('stores a number held by a property of a cited element as a value slot', () => {
    const numeric: GraphNode = { ...node('W-1', 'Ana Silva'), properties: [{ key: 'limit', value: 5000, dataClass: 'number', masked: false }] };
    expect(textOf(convert([sentence('Ana Silva has 5000.', 'n1')], [numeric])[0])).toBe('‹widget#1› has ‹value#1›.');
  });

  it('keeps a value inside a list or an object of a cited element unstorable, also when another cited element holds it as a scalar', () => {
    const listed: GraphNode = { ...node('W-1', 'Ana Silva'), properties: [{ key: 'tags', value: ['alpha', 'beta'], dataClass: 'list', masked: false }] };
    const object: GraphNode = { ...node('W-1', 'Ana Silva'), properties: [{ key: 'meta', value: { origin: 'north' }, dataClass: 'other', masked: false }] };
    expect(reasonOf(convert([sentence('Ana Silva has beta.', 'n1')], [listed])[0])).toBe('property-value');
    expect(reasonOf(convert([sentence('Ana Silva is north.', 'n1')], [object])[0])).toBe('property-value');
    const alias: GraphNode = { ...node('W-2', 'Bo Chen'), properties: [{ key: 'aliases', value: ['gold'], dataClass: 'list', masked: true }] };
    expect(reasonOf(convert([sentence('Bo Chen is known as gold.', 'n1', 'n2')], [node('W-1', 'Ana Silva', 'widget', 'gold'), alias])[0])).toBe('property-value');
  });

  it('merges values that differ only in case, so a masked property cannot be shown through another one', () => {
    const band: GraphNode = { ...node('W-2', 'Bo Chen'), properties: [{ key: 'band', value: 'gold', dataClass: 'text', masked: true }] };
    expect(reasonOf(convert([sentence('Bo Chen is gold.', 'n1', 'n2')], [node('W-1', 'Ana Silva', 'widget', 'Gold'), band])[0])).toBe('property-value');
    const named = (id: string, title: string, value: string): GraphNode => ({ ...node(id, title), properties: [{ key: 'name', value, dataClass: 'text', masked: false }] });
    const [both] = convert([sentence('Ana Silva and Bo Chen are Acme.', 'n1', 'n2')], [named('W-1', 'Ana Silva', 'ACME'), named('W-2', 'Bo Chen', 'Acme')]);
    expect(slotOf(both)?.descriptor).toMatchObject({ kind: 'value', key: 'name', of: [{ ref: W1 }, { ref: W2 }] });
  });
});

describe('tally slots', () => {
  const accounts = [node('A-1', 'Gizmo One', 'gizmo', 'x1'), node('A-2', 'Gizmo Two', 'gizmo', 'x2'), node('A-3', 'Gizmo Three', 'gizmo', 'x3')];

  it('stores a number word or digits that equal the count of cited entities of a type, with the type word, as a count slot', () => {
    const [word] = convert([sentence('Ana Silva owns three gizmos.', 'n1', 'n2', 'n3', 'n4')], [node('W-1', 'Ana Silva'), ...accounts]);
    expect(textOf(word)).toBe('‹widget#1› owns ‹count#1›.');
    expect(word?.storable === true ? word.placeholders.find((placeholder) => placeholder.descriptor.kind === 'tally')?.descriptor : undefined).toMatchObject({ kind: 'tally', suffix: 's' });
    expect(textOf(convert([sentence('Ana Silva owns 3 gizmos.', 'n1', 'n2', 'n3', 'n4')], [node('W-1', 'Ana Silva'), ...accounts])[0])).toBe('‹widget#1› owns ‹count#1›.');
  });

  it('does not store a number that is not the count of cited entities of that type', () => {
    expect(reasonOf(convert([sentence('Ana Silva owns four gizmos.', 'n1', 'n2', 'n3', 'n4')], [node('W-1', 'Ana Silva'), ...accounts])[0])).toBe('number-or-date');
    expect(reasonOf(convert([sentence('Ana Silva owns two gizmos.', 'n1', 'n2', 'n3', 'n4')], [node('W-1', 'Ana Silva'), ...accounts])[0])).toBe('number-or-date');
  });
});
