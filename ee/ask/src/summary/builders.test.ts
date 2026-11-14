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

  it('names the kinds of relationships and neighbors of each type and direction, without any count, each citing the anchor', () => {
    const preview: DegreePreview = { ref: ref('a-1'), total: { quality: 'estimated', value: 1500, scope: 's' }, byType: [{ relationshipType: 'LINKS', direction: 'out', count: { quality: 'lowerBound', value: 40, scope: 's' }, neighborTypes: ['node_b'] }, { relationshipType: 'HOLDS', direction: 'in', count: { quality: 'unknown', scope: 's' }, neighborTypes: ['node_c'] }], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    const summary = checked({ templateId: 'degree-preview', result: preview });
    const text = summary.sentences.map((sentence) => sentence.text).join(' ');
    expect(text).toContain('a-1 has outgoing LINKS relationships to node_b.');
    expect(text).toContain('a-1 has incoming HOLDS relationships to');
    expect(text).not.toMatch(/estimated|lower bound|exact|no count|1,500|\b40\b/);
    expect(summary.citations).toHaveLength(1);
  });

  it('says an exact total of nothing, and has no summary for a total that is not nothing with no group', () => {
    const none: DegreePreview = { ref: ref('a-1'), total: exact(0), byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    expect(checked({ templateId: 'degree-preview', result: none }).sentences[0]?.text).toBe('a-1 has no relationships.');
    expect(buildSummary({ templateId: 'degree-preview', result: { ...none, total: { quality: 'unknown', scope: 's' } } })).toBeUndefined();
  });
});

describe('the summary of a shared-attribute or linked-entities run', () => {
  const anchor = node('a-1', 'Alice');
  const bob = node('b-1', 'Bob');
  const unnamed = node('b-2', '');
  const matches = [bob, unnamed];

  it('names the matches in one sentence that says it is not the whole list when the count is a lower bound, repeats no count and no notice, and keeps the omissions line', () => {
    const run = ok({ count: { quality: 'lowerBound', value: 2, scope: 's' }, matchIds: matches.map((m) => m.ref), nodes: [anchor, ...matches], notices: [{ code: 'noStopList' }, { code: 'supernodesSkipped', entities: [ref('gone')] }] });
    const summary = checked({ templateId: 'shared-attribute', result: run }, anchor.ref);
    const text = summary.sentences.map((sentence) => sentence.text).join(' ');
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['The records that share an attribute with Alice include Bob and b-2.']);
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', 'Bob', 'b-2']);
    expect(text).not.toMatch(/lower bound.*lower bound|stop list|supernode|exact/);
    expect(summary.omissions).toBe('2 shown; more may exist (lower bound).');
    expect(JSON.stringify(summary)).not.toContain('gone');
  });

  it('says so when nothing matches, citing the anchor, and falls back to the first listed node', () => {
    const none = ok({ nodes: [anchor] });
    expect(checked({ templateId: 'shared-attribute', result: none }, anchor.ref).sentences[0]?.text).toBe('No other record shares an attribute with Alice.');
    expect(checked({ templateId: 'shared-attribute', result: none }).citations[0]?.title).toBe('Alice');
    expect(buildSummary({ templateId: 'shared-attribute', result: ok() })).toBeUndefined();
  });

  it('names the linked entities in one sentence, and the ones reached through an entity the result lists in one more, with no line for each match', () => {
    const middle = node('m-1', 'Mia');
    const run = ok({ templateId: 'linked-entities', count: exact(2), matchIds: matches.map((m) => m.ref), links: [{ match: bob.ref, hops: 1 }, { match: unnamed.ref, hops: 2, through: middle.ref }], nodes: [anchor, ...matches, middle] });
    const text = textOf({ templateId: 'linked-entities', result: run }, anchor.ref);
    expect(JSON.parse(text).sentences.map((sentence: { text: string }) => sentence.text)).toEqual(['Alice reaches Bob and b-2.', 'b-2 is reached through Mia.']);
    expect(JSON.parse(text).citations.map((citation: { title: string }) => citation.title)).toEqual(['Alice', 'Bob', 'b-2', 'Mia']);
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

  it('gives one sentence for each neighbor type that names the neighbors, with no count, total or page note, citing the anchor and the neighbors', () => {
    const result: ExpandResponse = { ref: anchor.ref, pageSize: 25, nodes: [anchor, neighbor], edges: [edge('a-1', 'b-1')], pages: [{ neighborType: 'node_b', returned: 1, hasMore: true, matchingTotal: { quality: 'lowerBound', value: 26, scope: 's' } }], warnings: [] };
    const summary = checked({ templateId: 'expand', result });
    expect(summary.sentences[0]?.text).toBe('node_b neighbors of Alice include Bob.');
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
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Rule r1 (version 2) links Alice to Bob.', 'Rule r2 (version 1) found nothing linked to Alice.']);
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
    expect(summary.sentences).toHaveLength(1);
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

  it('names the first exact, related and supporting hits without any count, and repeats nothing typed, matched, contextual or recorded', () => {
    const run: AskRunResult = { templateId: 'search', result: base() };
    const text = textOf(run);
    expect(text).toContain('Exact matches include Alice.');
    expect(text).toContain('Related records include Rita.');
    expect(text).toContain('Supporting relationships include HOLDS: Alice → lone.');
    expect(text).not.toMatch(/1 · exact|including/);
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

  it('says nothing of a total that is unknown, for a degree preview and for a rule, so it never reads as none', () => {
    const preview: DegreePreview = { ref: anchor.ref, total: { quality: 'unknown', scope: 's' }, byType: [], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    expect(buildSummary({ templateId: 'degree-preview', result: preview })).toBeUndefined();
    const result: DerivedNeighborsResponse = { ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 1, count: { quality: 'unknown', scope: 's' }, nodes: [anchor], edges: [], warnings: [] }] };
    expect(buildSummary({ templateId: 'derived-rule-run', result })).toBeUndefined();
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
    expect(summary.sentences.map((sentence) => sentence.text)).toEqual(['Exact matches include Ann.']);
  });
});

describe('the sentences that name the matches, in each form', () => {
  const anchor = node('a-1', 'Alice');
  const names = (count: number) => Array.from({ length: count }, (_, index) => node(`m-${index}`, `Name ${index}`));
  const shared = (matches: GraphNode[], over: Partial<TemplateRunOk> = {}): AskRunResult => ({ templateId: 'shared-attribute', result: ok({ count: exact(matches.length), matchIds: matches.map((entry) => entry.ref), nodes: [anchor, ...matches], ...over }) });
  const sentences = (run: AskRunResult, from?: ElementRef) => checked(run, from ?? anchor.ref).sentences.map((sentence) => sentence.text);

  it('reads as the whole list for an exact count of five or fewer, in the singular for one, and cites the anchor before the matches', () => {
    expect(sentences(shared(names(1)))).toEqual(['Name 0 shares an attribute with Alice.']);
    expect(sentences(shared(names(2)))).toEqual(['Name 0 and Name 1 share an attribute with Alice.']);
    expect(checked(shared(names(2)), anchor.ref).citations.map((citation) => citation.title)).toEqual(['Alice', 'Name 0', 'Name 1']);
  });

  it('reads as including for more than five listed matches and for a count that is not exact', () => {
    expect(sentences(shared(names(7)))).toEqual(['The records that share an attribute with Alice include Name 0, Name 1, Name 2, Name 3 and Name 4.']);
    expect(sentences(shared(names(2), { count: { quality: 'estimated', value: 40, scope: 's' } }))).toEqual(['The records that share an attribute with Alice include Name 0 and Name 1.']);
  });

  it('has no summary for a count that is not nothing when the result lists no match', () => {
    expect(buildSummary(shared([], { count: exact(3) }), { anchor: anchor.ref })).toBeUndefined();
    expect(buildSummary(shared([], { count: { quality: 'lowerBound', value: 1, scope: 's' } }), { anchor: anchor.ref })).toBeUndefined();
  });

  it('repeats no notice, in the zero path or with matches, and cites no supernode a notice names', () => {
    const gone = node('s-1', 'Super');
    const zero = shared([], { count: exact(0), notices: [{ code: 'noStopList' }] });
    expect(sentences(zero)).toEqual(['No other record shares an attribute with Alice.']);
    const withSuper = shared(names(1), { nodes: [anchor, ...names(1), gone], notices: [{ code: 'supernodesSkipped', entities: [gone.ref] }, { code: 'noStopList' }] });
    expect(JSON.stringify(checked(withSuper, anchor.ref))).not.toMatch(/Super|stop list|supernode/);
  });

  it('writes a linked run as reaches, with the ones reached through a listed entity in one sentence in the singular or the plural', () => {
    const [b, c] = names(2);
    const mid = node('mid', 'Mia');
    const linked = (links: object[]): AskRunResult => ({ templateId: 'linked-entities', result: ok({ templateId: 'linked-entities', count: exact(2), matchIds: [b?.ref, c?.ref] as ElementRef[], links: links as never, nodes: [anchor, b as GraphNode, c as GraphNode, mid] }) });
    expect(sentences(linked([{ match: (b as GraphNode).ref, hops: 2, through: mid.ref }, { match: (c as GraphNode).ref, hops: 2, through: mid.ref }]))).toEqual(['Alice reaches Name 0 and Name 1.', 'Name 0 and Name 1 are reached through Mia.']);
    expect(sentences(linked([{ match: (b as GraphNode).ref, hops: 1 }, { match: (c as GraphNode).ref, hops: 1 }]))).toEqual(['Alice reaches Name 0 and Name 1.']);
  });

  it('tries three names and then one, as a part of the list, in a derived, an expand and a search sentence with long titles', () => {
    const long = (index: number, type = 'node_b') => node(`l-${index}`, `${'x'.repeat(70)}${index}`, type);
    const ends = [0, 1, 2, 3, 4].map((index) => long(index));
    const derivedEdges = ends.map((end) => edge('a-1', end.ref.stableId, { to: end.ref, semantics: 'derived', ref: { sourceId: 'demo', derived: { ruleId: 'r1', from: ref('a-1'), to: end.ref } } }));
    const derived: DerivedNeighborsResponse = { ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 1, count: exact(5), nodes: [anchor, ...ends], edges: derivedEdges, warnings: [] }] };
    expect(sentences({ templateId: 'derived-rule-run', result: derived })[0]).toMatch(/^Rule r1 \(version 1\) links Alice to, among others, /);
    const expand: ExpandResponse = { ref: anchor.ref, pageSize: 25, nodes: [anchor, ...ends], edges: [], pages: [{ neighborType: 'node_b', returned: 5, hasMore: false, matchingTotal: exact(5) }], warnings: [] };
    expect(sentences({ templateId: 'expand', result: expand })[0]).toMatch(/^node_b neighbors of Alice include /);
    expect(sentences({ templateId: 'expand', result: expand })[0]).not.toContain('l-4');
    expect(sentences({ templateId: 'expand', result: expand })[0]?.length).toBeLessThanOrEqual(300);
    const search = { sourceId: 'demo', exact: ends, exactMatches: [], cap: 25, searchable: true, counts: { exact: exact(5) }, disabledTypes: [], related: { hits: [], count: exact(0), searchable: true, disabledTypes: [] }, evidence: { hits: [], count: exact(0), searchable: true, disabledRelationshipTypes: [] }, failures: [], dropped: {}, warnings: [], elapsedMs: 1 } as unknown as SearchResult;
    const found = sentences({ templateId: 'search', result: search })[0] ?? '';
    expect(found).toMatch(/^Exact matches include /);
    expect(found.length).toBeLessThanOrEqual(300);
    expect(found).not.toContain('l-4');
  });

  it('writes the expand sentence in the singular, the plural and as including, and none for a page that names no neighbor', () => {
    const [b, c] = [node('b-1', 'Bob', 'node_b'), node('b-2', 'Cy', 'node_b')];
    const page = (returned: number, hasMore: boolean) => ({ neighborType: 'node_b', returned, hasMore, matchingTotal: exact(returned) });
    const result = (nodes: GraphNode[], hasMore = false, pages = [page(nodes.length, hasMore)]): AskRunResult => ({ templateId: 'expand', result: { ref: anchor.ref, pageSize: 25, nodes: [anchor, ...nodes], edges: [], pages, warnings: [] } as ExpandResponse });
    expect(sentences(result([b]))).toEqual(['The node_b neighbor of Alice is Bob.']);
    expect(sentences(result([b, c]))).toEqual(['Bob and Cy are node_b neighbors of Alice.']);
    expect(sentences(result([b], true))).toEqual(['node_b neighbors of Alice include Bob.']);
    expect(buildSummary(result([], false, [page(0, false)]))).toBeUndefined();
  });

  it('says that a rule links the anchor to other entities only for a count of at least one, and nothing for a count with no value', () => {
    const rule = (count: object): DerivedNeighborsResponse => ({ ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 1, count: count as never, nodes: [anchor], edges: [], warnings: [] }] });
    expect(sentences({ templateId: 'derived-rule-run', result: rule(exact(2)) })).toEqual(['Rule r1 (version 1) links Alice to other entities.']);
    expect(buildSummary({ templateId: 'derived-rule-run', result: rule({ quality: 'lowerBound', value: 0, scope: 's' }) })).toBeUndefined();
  });
});

describe('the sentences never say more than the result lists', () => {
  const anchor = node('a-1', 'Alice');
  const [b, c] = [node('b-1', 'Bob'), node('c-1', 'Cy')];

  it('reads as including when an exact count is larger than the matches listed, for a template run, a derived rule and a file query', () => {
    const run: AskRunResult = { templateId: 'shared-attribute', result: ok({ count: exact(38), matchIds: [b.ref], nodes: [anchor, b] }) };
    expect(checked(run, anchor.ref).sentences[0]?.text).toBe('The records that share an attribute with Alice include Bob.');
    const edgeTo = edge('a-1', 'b-1', { to: b.ref, semantics: 'derived', ref: { sourceId: 'demo', derived: { ruleId: 'r1', from: ref('a-1'), to: ref('b-1') } } });
    const rule: DerivedNeighborsResponse = { ref: anchor.ref, results: [{ ruleId: 'r1', ruleVersion: 1, count: exact(10), nodes: [anchor, b], edges: [edgeTo], warnings: [] }] };
    expect(checked({ templateId: 'derived-rule-run', result: rule }).sentences[0]?.text).toBe('Rule r1 (version 1) links Alice to, among others, Bob.');
  });

  it('pairs each match with its own middle entities when the sentence names several, keeping matches in order while their middles fit the limit', () => {
    const [m1, m2, m3, m4] = [node('m1', 'Mia'), node('m2', 'Max'), node('m3', 'Meg'), node('m4', 'Moe')];
    const linked = (links: object[]): AskRunResult => ({ templateId: 'linked-entities', result: ok({ templateId: 'linked-entities', count: exact(2), matchIds: [b.ref, c.ref], links: links as never, nodes: [anchor, b, c, m1, m2, m3, m4] }) });
    // each match is named with the middles of the kept matches only
    expect(checked(linked([{ match: b.ref, hops: 4, through: m1.ref }, { match: c.ref, hops: 2, through: m2.ref }]), anchor.ref).sentences[1]?.text).toBe('Bob and Cy are reached through Mia and Max.');
    // a match whose middle is not listed is not named in the sentence
    expect(checked(linked([{ match: b.ref, hops: 2, through: ref('unlisted') }, { match: c.ref, hops: 2, through: m3.ref }]), anchor.ref).sentences[1]?.text).toBe('Cy is reached through Meg.');
  });

  it('keeps the anchor first and the matches in order in the citations of a sentence retried with fewer names', () => {
    const many = Array.from({ length: 5 }, (_, index) => node(`m-${index}`, `${'x'.repeat(70)}${index}`));
    const run: AskRunResult = { templateId: 'shared-attribute', result: ok({ count: exact(5), matchIds: many.map((entry) => entry.ref), nodes: [anchor, ...many] }) };
    const summary = checked(run, anchor.ref);
    expect(summary.sentences[0]?.text.startsWith('The records that share an attribute with Alice include ')).toBe(true);
    expect(summary.citations.map((citation) => citation.title)).toEqual(['Alice', many[0]?.display.title, many[1]?.display.title, many[2]?.display.title]);
  });

  it('says a retried degree sentence as including, so a shortened list of neighbor types never reads as the whole', () => {
    const types = Array.from({ length: 5 }, (_, index) => `${'t'.repeat(60)}${index}`);
    const preview: DegreePreview = { ref: ref('a-1'), total: exact(5), byType: [{ relationshipType: 'LINKS', direction: 'out', count: exact(5), neighborTypes: types }], byNeighborType: [], warnings: [], pageSize: 25, heavyOpThreshold: 1000 };
    const text = checked({ templateId: 'degree-preview', result: preview }).sentences[0]?.text ?? '';
    expect(text).toContain('relationships to types including ');
    expect(text.length).toBeLessThanOrEqual(300);
  });
});
