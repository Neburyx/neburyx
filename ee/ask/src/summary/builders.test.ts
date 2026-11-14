import { askSummarySchema, type AskRunResult, type DegreePreview, type DerivedEdgeDetail, type DerivedNeighborsResponse, type ElementRef, type ExpandResponse, type GraphEdge, type GraphNode, type SearchResult, type TemplateRunOk } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildSummary, listedElements, citedKeysExist } from './index.js';

const ref = (stableId: string, entityType = 'node_a'): ElementRef => ({ sourceId: 'demo', entityType, stableId });
const node = (stableId: string, title = stableId, entityType = 'node_a', secret = 'MASKED-SECRET-VALUE'): GraphNode => ({
  ref: ref(stableId, entityType),
  display: { title, type: entityType },
  properties: [{ key: 'private', value: secret, dataClass: 'text', masked: false }],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const exact = (value: number) => ({ quality: 'exact' as const, value, scope: 's' });
const edge = (from: string, to: string, over: Partial<GraphEdge> = {}): GraphEdge => ({ ref: { sourceId: 'demo', type: 'LINKS', from: 'node_a', to: 'node_a', stableId: `${from}-${to}` }, from: ref(from), to: ref(to), type: 'LINKS', direction: 'from-to', semantics: 'stored', properties: [], ...over }) as GraphEdge;
const ok = (over: Partial<TemplateRunOk> = {}): TemplateRunOk => ({ status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: exact(0), matchIds: [], nodes: [], edges: [], notices: [], warnings: [], ...over });

function checked(run: AskRunResult, anchor?: ElementRef) {
  const summary = buildSummary(run, { anchor });
  const listed = listedElements(run);
  if (summary === undefined || listed === undefined) throw new Error('no summary');
  expect(askSummarySchema.safeParse(summary).success).toBe(true);
  expect(citedKeysExist(summary, listed)).toBe(true);
  return summary;
}
const textOf = (run: AskRunResult, anchor?: ElementRef): string => JSON.stringify(checked(run, anchor));

describe('the summary of an entity and of a degree preview', () => {
  it('names the entity by its title and type, or by its stable ID when the title is empty, and never repeats a property value', () => {
    expect(checked({ templateId: 'entity', result: node('a-1', 'Alice') }).sentences[0]?.text).toBe('Alice is of type node_a.');
    const empty = textOf({ templateId: 'entity', result: node('a-1', '') });
    expect(empty).toContain('a-1 is of type node_a.');
    expect(empty).not.toContain('MASKED-SECRET-VALUE');
  });

  it('gives the total and the count of each type and direction with their labels, each citing the anchor', () => {
    const preview: DegreePreview = { ref: ref('a-1'), total: { quality: 'estimated', value: 1500, scope: 's' }, byType: [{ relationshipType: 'LINKS', direction: 'out', count: { quality: 'lowerBound', value: 40, scope: 's' }, neighborTypes: ['node_b'] }, { relationshipType: 'HOLDS', direction: 'in', count: { quality: 'unknown', scope: 's' }, neighborTypes: ['node_c'] }], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    const summary = checked({ templateId: 'degree-preview', result: preview });
    const text = summary.sentences.map((sentence) => sentence.text).join(' ');
    expect(text).toContain('~ 1,500 (estimated)');
    expect(text).toContain('≥ 40 · lower bound');
    expect(text).toContain('HOLDS (incoming): no count');
    expect(text).toContain('LINKS (outgoing)');
    expect(summary.citations).toHaveLength(1);
  });
});

describe('the summary of a shared-attribute or linked-entities run', () => {
  const anchor = node('a-1', 'Alice');
  const bob = node('b-1', 'Bob');
  const unnamed = node('b-2', '');
  const matches = [bob, unnamed];

  it('gives the count, names the first matches, and says how many are not yet retrieved, with the notices', () => {
    const run = ok({ count: { quality: 'lowerBound', value: 2, scope: 's' }, matchIds: matches.map((m) => m.ref), nodes: [anchor, ...matches], notices: [{ code: 'noStopList' }, { code: 'supernodesSkipped', entities: [ref('gone')] }] });
    const summary = checked({ templateId: 'shared-attribute', result: run }, anchor.ref);
    const text = summary.sentences.map((sentence) => sentence.text).join(' ');
    expect(text).toContain('≥ 2 · lower bound');
    expect(text).toContain('Bob and b-2');
    expect(text).toContain('1 supernode was not traversed.');
    expect(summary.omissions).toBe('2 shown; more may exist (lower bound).');
    expect(JSON.stringify(summary)).not.toContain('gone');
  });

  it('says so when nothing matches, citing the anchor, and falls back to the first listed node', () => {
    const none = ok({ nodes: [anchor] });
    expect(checked({ templateId: 'shared-attribute', result: none }, anchor.ref).sentences[0]?.text).toBe('No other record shares an attribute with Alice.');
    expect(checked({ templateId: 'shared-attribute', result: none }).citations[0]?.title).toBe('Alice');
    expect(buildSummary({ templateId: 'shared-attribute', result: ok() })).toBeUndefined();
  });

  it('says how each linked entity was reached, with the entity in between for two hops', () => {
    const middle = node('m-1', 'Mia');
    const run = ok({ templateId: 'linked-entities', count: exact(2), matchIds: matches.map((m) => m.ref), links: [{ match: bob.ref, hops: 1 }, { match: unnamed.ref, hops: 2, through: middle.ref }], nodes: [anchor, ...matches, middle] });
    const text = textOf({ templateId: 'linked-entities', result: run }, anchor.ref);
    expect(text).toContain('Bob is reached in one hop.');
    expect(text).toContain('b-2 is reached in two hops, through Mia.');
  });

  it('has no summary for a run that stopped as heavy', () => {
    const heavy: Extract<AskRunResult, { templateId: 'shared-attribute' }>['result'] = { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', estimate: { quality: 'lowerBound', value: 10, scope: 's' }, threshold: 10, continueLimit: 25, notices: [], warnings: [] };
    expect(buildSummary({ templateId: 'shared-attribute', result: heavy })).toBeUndefined();
    expect(listedElements({ templateId: 'shared-attribute', result: heavy })).toBeUndefined();
  });
});

describe('the summary of an expansion and of derived results', () => {
  const anchor = node('a-1', 'Alice');
  const neighbor = node('b-1', 'Bob', 'node_b');

  it('gives one sentence for each neighbor type with the matching total and whether more pages exist, citing the anchor and the first neighbors', () => {
    const result: ExpandResponse = { ref: anchor.ref, pageSize: 25, nodes: [anchor, neighbor], edges: [edge('a-1', 'b-1')], pages: [{ neighborType: 'node_b', returned: 1, hasMore: true, matchingTotal: { quality: 'lowerBound', value: 26, scope: 's' } }], warnings: [] };
    const summary = checked({ templateId: 'expand', result });
    expect(summary.sentences[0]?.text).toBe('node_b of Alice: 1 returned (total: ≥ 26 · lower bound), including Bob. More pages exist.');
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'Bob']);
  });

  it('cites the anchor when the expansion lists nothing else, with a stable ID for the title', () => {
    const result: ExpandResponse = { ref: ref('lone'), pageSize: 25, nodes: [], edges: [], pages: [], warnings: [] };
    const summary = checked({ templateId: 'expand', result });
    expect(summary.sentences[0]?.text).toBe('No neighbors of lone were returned.');
  });

  it('gives each rule its own sentence, with an exact zero for a rule that found nothing, and names the other ends', () => {
    const derivedEdge = edge('a-1', 'b-1', { to: neighbor.ref, semantics: 'derived', ref: { sourceId: 'demo', derived: { ruleId: 'r1', from: ref('a-1'), to: ref('b-1') } } });
    const result: DerivedNeighborsResponse = { ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 2, count: exact(1), nodes: [anchor, neighbor], edges: [derivedEdge], warnings: [] }, { ruleId: 'r2', ruleVersion: 1, count: exact(0), nodes: [], edges: [], warnings: [] }] };
    const summary = checked({ templateId: 'derived-rule-run', result });
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Rule r1 (version 2), other ends linked to Alice: 1 · exact, including Bob.', 'Rule r2 (version 1) found nothing linked to Alice.']);
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'Bob']);
  });

  it('titles a derived relationship with its type and the titles of its two ends, a stable ID when the end is not a listed node', () => {
    const end = (id: string, title: string) => ({ ref: ref(id), title, type: 'node_a' });
    const detail: DerivedEdgeDetail = {
      ref: { sourceId: 'demo', derived: { ruleId: 'r1', from: ref('a-1'), to: ref('b-1') } },
      type: 'LINKS',
      semantics: 'derived',
      rule: { id: 'r1', version: 3 },
      from: end('a-1', 'Alice'),
      to: end('b-1', ''),
      supports: { count: exact(1), groups: [{ middle: [end('m-1', 'Mia')], supports: [{ ref: { sourceId: 'demo', type: 'HOLDS', from: 'node_a', to: 'node_a', stableId: 's-1' }, type: 'HOLDS', from: end('a-1', 'Alice'), to: end('m-1', 'Mia'), evidence: { status: 'not-available', code: 'evidence-not-available' } as never }] }] },
      qualityFlags: [],
      warnings: [],
    };
    const summary = checked({ templateId: 'derived-edge-support', result: detail });
    expect(summary.sentences[0]?.text).toBe('Alice and b-1 are linked by rule r1 (version 3).');
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'b-1', 'LINKS: Alice → b-1']);
    expect(summary.sentences[1]?.text).toBe('Supporting chains: 1 · exact.');
  });
});

describe('the summary of a search', () => {
  const exactNode = node('a-1', 'Alice');
  const base = (over: Partial<SearchResult> = {}): SearchResult => ({
    sourceId: 'demo',
    exact: [exactNode],
    exactMatches: [{ ref: exactNode.ref, matchedProperties: ['TYPED-PROPERTY'] }],
    cap: 25,
    searchable: true,
    counts: { exact: exact(1) },
    disabledTypes: [],
    related: { hits: [{ node: node('r-1', 'Rita'), matchedProperties: ['RELATED-PROPERTY'], context: { relationshipType: 'CTX-TYPE', direction: 'out', with: ref('a-1') } }], count: exact(1), searchable: true, disabledTypes: [] },
    evidence: { hits: [{ aggregate: { type: 'HOLDS', from: ref('a-1'), to: ref('lone') }, members: [{ records: [{ sourceRecordId: 'SOURCE-RECORD-9' }] }], memberCount: { quality: 'exact', value: 1, scope: 'm' }, rules: [] }], count: exact(1), searchable: true, disabledRelationshipTypes: [] },
    failures: [],
    dropped: {},
    warnings: [],
    elapsedMs: 1,
    ...over,
  }) as SearchResult;

  it('gives the counts with their labels, names the first exact matches, and repeats nothing typed, matched, contextual or recorded', () => {
    const run: AskRunResult = { templateId: 'search', result: base() };
    const text = textOf(run);
    expect(text).toContain('Exact matches: 1 · exact, including Alice.');
    expect(text).toContain('Related records: 1 · exact, including Rita.');
    for (const hidden of ['TYPED-PROPERTY', 'RELATED-PROPERTY', 'CTX-TYPE', 'SOURCE-RECORD-9', 'MASKED-SECRET-VALUE']) expect(text).not.toContain(hidden);
  });

  it('titles an aggregate hit by its type and its ends (a stable ID for an end that is no listed node), and a stored hit by its type, end types and own stable ID', () => {
    const stored = { supports: { sourceId: 'demo', type: 'PAYS', from: 'node_a', to: 'node_b', stableId: 'rel-7' }, records: [{ sourceRecordId: 'x' }], rules: [] };
    const run: AskRunResult = { templateId: 'search', result: base({ evidence: { hits: [...base().evidence.hits, stored], count: exact(2), searchable: true, disabledRelationshipTypes: [] } as never }) };
    const titles = checked(run).citations.map((citation) => citation.title);
    expect(titles).toContain('HOLDS: Alice → lone');
    expect(titles).toContain('PAYS: node_a → node_b (rel-7)');
  });

  it('says when a group could not be read or searched, and has no summary when nothing is listed', () => {
    const failed = textOf({ templateId: 'search', result: base({ failures: [{ group: 'related', code: 'timeout' } as never], searchable: false }) });
    expect(failed).toContain('The related group could not be read.');
    expect(failed).toContain('No property could be searched.');
    const empty = base({ exact: [], exactMatches: [], counts: { exact: exact(0) }, related: { hits: [], count: exact(0), searchable: true, disabledTypes: [] }, evidence: { hits: [], count: exact(0), searchable: true, disabledRelationshipTypes: [] } });
    expect(buildSummary({ templateId: 'search', result: empty })).toBeUndefined();
  });
});

describe('the summary of any result', () => {
  it('is the same when built twice, and cites only elements the result lists', () => {
    const run: AskRunResult = { templateId: 'entity', result: node('a-1', 'Alice') };
    expect(buildSummary(run)).toEqual(buildSummary(run));
  });
});

describe('the words that must not read as a number the result does not have', () => {
  const anchor = node('a-1', 'Alice');

  it('puts an unknown total after a colon, so it never reads as none, for a degree preview and for a rule', () => {
    const preview: DegreePreview = { ref: anchor.ref, total: { quality: 'unknown', scope: 's' }, byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    expect(checked({ templateId: 'degree-preview', result: preview }).sentences[0]?.text).toBe('Relationships of a-1: no count.');
    const result: DerivedNeighborsResponse = { ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 1, count: { quality: 'unknown', scope: 's' }, nodes: [anchor], edges: [], warnings: [] }] };
    expect(checked({ templateId: 'derived-rule-run', result }).sentences[0]?.text).toBe('Rule r1 (version 1), other ends linked to Alice: no count.');
  });

  it('says what is shown of a template run when the count is exact, and that more may exist when it is a lower bound, never a remainder of zero', () => {
    const bob = node('b-1', 'Bob');
    const exactRun = ok({ count: exact(1), matchIds: [bob.ref], nodes: [anchor, bob] });
    expect(checked({ templateId: 'shared-attribute', result: exactRun }, anchor.ref).omissions).toBe('1 shown.');
    const cutRun = ok({ count: { quality: 'lowerBound', value: 1, scope: 's' }, matchIds: [bob.ref], nodes: [anchor, bob] });
    expect(checked({ templateId: 'shared-attribute', result: cutRun }, anchor.ref).omissions).toBe('1 shown; more may exist (lower bound).');
  });

  it('writes the omissions line of an expansion from what its pages returned and their totals, with the quality rule', () => {
    const neighbor = node('b-1', 'Bob', 'node_b');
    const result = (matchingTotal: { quality: 'exact' | 'estimated' | 'lowerBound' | 'unknown'; value?: number; scope: string }): ExpandResponse => ({ ref: anchor.ref, pageSize: 25, nodes: [anchor, neighbor], edges: [], pages: [{ neighborType: 'node_b', returned: 1, hasMore: true, matchingTotal }], warnings: [] });
    expect(checked({ templateId: 'expand', result: result({ quality: 'estimated', value: 39, scope: 's' }) }).omissions).toBe('1 shown; ~ 38 (estimated) not yet retrieved.');
    const mixed: ExpandResponse = { ...result({ quality: 'estimated', value: 1500, scope: 's' }), pages: [{ neighborType: 'node_b', returned: 1, hasMore: true, matchingTotal: { quality: 'estimated', value: 1500, scope: 's' } }, { neighborType: 'node_c', returned: 1, hasMore: true, matchingTotal: { quality: 'lowerBound', value: 25, scope: 's' } }] };
    expect(checked({ templateId: 'expand', result: mixed }).omissions).toBe('2 shown; ~ 1,523 (estimated) not yet retrieved.');
    expect(checked({ templateId: 'expand', result: result({ quality: 'unknown', scope: 's' }) }).omissions).toBe('1 shown; how many are not yet retrieved is not known.');
    expect(checked({ templateId: 'expand', result: result({ quality: 'exact', value: 1, scope: 's' }) }).omissions).toBe('1 shown; 0 · exact not yet retrieved.');
  });

  it('leaves out the sentence of a search group that holds no hit, so no count is cited by an element of another group', () => {
    const exactNode = node('a-9', 'Ann');
    const empty = { hits: [], count: exact(0), searchable: true, disabledTypes: [] };
    const run = { sourceId: 'demo', exact: [exactNode], exactMatches: [], cap: 25, searchable: true, counts: { exact: exact(1) }, disabledTypes: [], related: empty, evidence: { hits: [], count: exact(0), searchable: true, disabledRelationshipTypes: [] }, failures: [], dropped: {}, warnings: [], elapsedMs: 1 } as unknown as SearchResult;
    const summary = checked({ templateId: 'search', result: run });
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Exact matches: 1 · exact, including Ann.']);
  });
});
