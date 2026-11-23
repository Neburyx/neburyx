import { describe, expect, it } from 'vitest';
import { ASK_RESULT_LINES_MAX, ASK_RESULT_NOTICE_ENTRIES_MAX, ASK_RESULT_REFS_MAX, ASK_RESULT_ROWS_MAX, storedAskResultOf, storedAskResultSchema } from './ask-result-stored.js';
import type { AskAnswer } from './ask-question.js';
import type { Count } from './graph.js';

/** The same projection over three vocabularies of made-up names: nothing of the code names a type. */
const VOCABULARIES = [
  { name: 'a first', thing: 'widget', other: 'gadget', link: 'MAKES', rule: 'rule-one' },
  { name: 'a second', thing: 'gizmo', other: 'sprocket', link: 'FEEDS_INTO', rule: 'rule-two' },
  { name: 'a third', thing: 'item', other: 'part', link: 'HOLDS', rule: 'rule-three' },
] as const;

const exact = (value: number): Count => ({ value, quality: 'exact', scope: 'matches' });
const SENTINEL = 'SENTINEL-TITLE';

function fixtures(v: (typeof VOCABULARIES)[number], title: string) {
  const ref = (id: string, type: string = v.thing) => ({ sourceId: 'demo', entityType: type, stableId: id });
  const node = (id: string, type: string = v.thing) => ({ ref: ref(id, type), display: { title: `${title} ${id}`, type }, properties: [{ key: 'holder', value: 'PROPERTY-VALUE', dataClass: 'text', masked: false }], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
  const edge = (id: string, from: string, to: string) => ({ ref: { sourceId: 'demo', type: v.link, from: v.thing, to: v.other, stableId: id }, from: ref(from), to: ref(to, v.other), type: v.link, direction: 'from-to', semantics: 'stored', properties: [{ key: 'note', value: 'PROPERTY-VALUE', dataClass: 'text', masked: false }], evidenceRefs: [], qualityFlags: [] });
  const answered = (result: unknown, over: Record<string, unknown> = {}): AskAnswer => ({ answered: { intent: 'x', entities: { [v.thing]: `${title}-TYPED` }, outcome: 'complete', result, ...over } }) as unknown as AskAnswer;
  return { ref, node, edge, answered };
}

describe.each(VOCABULARIES)('the stored result of an Ask answer over $name', (v) => {
  const f = fixtures(v, SENTINEL);
  const kinds: [string, AskAnswer][] = [
    ['shared-attribute', f.answered({ templateId: 'shared-attribute', result: { status: 'ok', count: exact(2), matchIds: [f.ref('ax1'), f.ref('ax2')], nodes: [f.node('ax1')], edges: [], notices: [{ code: 'noStopList' }], warnings: [] } })],
    ['linked-entities', f.answered({ templateId: 'linked-entities', result: { status: 'ok', count: exact(1), matchIds: [f.ref('ax1')], links: [{ match: f.ref('ax1'), hops: 1 }], nodes: [f.node('ax1')], edges: [], notices: [], warnings: [] } })],
    ['saved-pattern a pattern run', f.answered({ templateId: 'saved-pattern', result: { status: 'ok', count: exact(1), matches: [{}], nodes: [f.node('ax1')], edges: [], notices: [], warnings: [] } }, { intent: 'saved' })],
    ['saved-pattern a template run', f.answered({ templateId: 'saved-pattern', result: { status: 'ok', count: exact(1), matchIds: [f.ref('ax1')], nodes: [f.node('ax1')], edges: [], notices: [], warnings: [] } })],
    ['file-query', f.answered({ templateId: 'file-query', result: { status: 'ok', intent: 'q', count: exact(2), nodes: [f.node('ax1'), f.node('ax2'), f.node('bx1', v.other)], edges: [f.edge('ex1', 'ax1', 'bx1')], notices: [], warnings: [] } }, { label: 'Find them' })],
    ['entity', f.answered({ templateId: 'entity', result: f.node('ax1') })],
    ['degree-preview', f.answered({ templateId: 'degree-preview', result: { total: exact(9), byType: [{ relationshipType: v.link, direction: 'out', count: exact(5), neighborTypes: [v.other] }] } })],
    ['expand', f.answered({ templateId: 'expand', result: { pages: [{ neighborType: v.other, returned: 3, hasMore: true, matchingTotal: exact(7) }] } })],
    ['derived-rule-run', f.answered({ templateId: 'derived-rule-run', result: { results: [{ ruleId: v.rule, count: exact(4) }] } })],
    ['derived-edge-support', f.answered({ templateId: 'derived-edge-support', result: { supports: { count: exact(2) } } })],
    ['search', f.answered({ templateId: 'search', result: { counts: { exact: exact(1) }, related: { count: exact(2) }, evidence: { count: exact(3) } } })],
    ['shortest-paths', f.answered({ templateId: 'shortest-paths', result: { status: 'ok', paths: [{ hops: 1, steps: [{ from: f.ref('ax1'), to: f.ref('bx1', v.other), relationshipType: v.link, evidenceRefs: [] }] }], nodes: [f.node('ax1'), f.node('bx1', v.other)], edges: [], capReached: false, partial: false, elapsedMs: 3, warnings: [] } })],
  ];

  it.each(kinds)('stores %s by counts and references, or as masked text, never a property value, and the schema takes it, written either way', (_name, answer) => {
    for (const maskOn of [false, true]) {
      const stored = storedAskResultOf(answer, maskOn);
      expect(stored).toBeDefined();
      expect(storedAskResultSchema.safeParse(stored).success).toBe(true);
      const bytes = JSON.stringify(stored);
      expect(bytes).not.toContain('PROPERTY-VALUE');
      // a title is in the block only as the masked text of a result written with the mask on, never beside references
      if (!maskOn) expect(bytes).not.toContain(SENTINEL + ' ');
    }
  });

  it('keeps the typed values under the rule of the question, the operator label alone, and no name of a pattern', () => {
    const stored = storedAskResultOf(f.answered({ templateId: 'entity', result: f.node('ax1') }, { label: 'Find them', patternName: 'MY-PATTERN', entities: { [v.thing]: 'typed text', pattern: 'p-1' } }), false);
    expect(stored?.values).toEqual([{ name: v.thing, text: 'typed text' }]);
    expect(stored?.label).toBe('Find them');
    expect(JSON.stringify(stored)).not.toContain('MY-PATTERN');
    const none = storedAskResultOf(f.answered({ templateId: 'entity', result: f.node('ax1') }, { patternName: 'MY-PATTERN' }), false);
    expect(none).not.toHaveProperty('label');
  });

  it('writes the rows of a file query as references with the mask off and as the masked text the gate returned with it on, relationships first', () => {
    const answer = kinds.find(([name]) => name === 'file-query')?.[1] as AskAnswer;
    expect(storedAskResultOf(answer, false)?.rows.map((row) => row.form)).toEqual(['ref', 'ref']);
    expect(storedAskResultOf(answer, true)?.rows).toEqual([{ form: 'frozen', text: `${SENTINEL} ax1 → ${v.link} → ${SENTINEL} bx1` }, { form: 'frozen', text: `${SENTINEL} ax2` }]);
  });

  it('writes an entity and the steps of a path as text with the mask on and as references with it off', () => {
    const entity = kinds.find(([name]) => name === 'entity')?.[1] as AskAnswer;
    expect(storedAskResultOf(entity, true)?.lines[0]?.item).toEqual({ form: 'frozen', text: `${SENTINEL} ax1` });
    expect(storedAskResultOf(entity, false)?.lines[0]?.item).toEqual({ form: 'ref', ref: f.ref('ax1') });
    const paths = kinds.find(([name]) => name === 'shortest-paths')?.[1] as AskAnswer;
    expect(storedAskResultOf(paths, true)?.paths[0]?.steps[0]).toMatchObject({ from: { form: 'frozen' }, to: { form: 'frozen' } });
    expect(storedAskResultOf(paths, false)?.paths[0]?.steps[0]).toMatchObject({ from: { form: 'ref' }, to: { form: 'ref' } });
  });

  it('stores a count only, an empty result and a heavy stop with their counts, and stores the estimate and the threshold of a heavy stop with no token', () => {
    const empty = storedAskResultOf(f.answered({ templateId: 'shared-attribute', result: { status: 'ok', count: exact(0), matchIds: [], nodes: [], edges: [], notices: [], warnings: [] } }), false);
    expect(empty).toMatchObject({ count: { count: { value: 0 }, noun: 'match' }, listed: 0 });
    const heavy = storedAskResultOf(f.answered({ templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'x', templateVersion: '1', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] } }, { continueToken: '1.' + 'a'.repeat(64) }), false);
    expect(heavy?.stop).toEqual({ estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500 });
    expect(JSON.stringify(heavy)).not.toContain('a'.repeat(64));
  });

  it('keeps the quality of every count as the result gave it, with no number for an unknown count', () => {
    for (const count of [exact(3), { value: 3, quality: 'estimated', scope: 's' }, { value: 3, quality: 'lowerBound', scope: 's' }, { quality: 'unknown', scope: 's' }] as Count[]) {
      const stored = storedAskResultOf(f.answered({ templateId: 'derived-edge-support', result: { supports: { count } } }), false);
      expect(stored?.lines[0]?.count).toEqual(count);
      expect(storedAskResultSchema.safeParse(stored).success).toBe(true);
    }
  });

  it('cuts the rows over the bound and counts them, cuts the lines over twelve and counts them, and never refuses', () => {
    const nodes = Array.from({ length: 40 }, (_, index) => f.node(`nx${index}`));
    const rows = storedAskResultOf(f.answered({ templateId: 'file-query', result: { status: 'ok', intent: 'q', count: exact(40), nodes, edges: [], notices: [], warnings: [] } }), true);
    expect(rows?.rows).toHaveLength(ASK_RESULT_ROWS_MAX);
    expect(rows).toMatchObject({ listed: 40, omitted: { rows: 40 - ASK_RESULT_ROWS_MAX } });
    const byType = Array.from({ length: 20 }, (_, index) => ({ relationshipType: `T${index}`, direction: 'out', count: exact(1), neighborTypes: [v.other] }));
    const lines = storedAskResultOf(f.answered({ templateId: 'degree-preview', result: { total: exact(20), byType } }), false);
    expect(lines?.lines).toHaveLength(ASK_RESULT_LINES_MAX);
    expect(lines?.omitted.lines).toBe(21 - ASK_RESULT_LINES_MAX);
    expect(storedAskResultSchema.safeParse(rows).success && storedAskResultSchema.safeParse(lines).success).toBe(true);
  });

  it('keeps a path whole or leaves it out, spends the budget of references in order, and counts the paths left out', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ hops: 4, steps: Array.from({ length: 4 }, (_, hop) => ({ from: f.ref(`P${index}-${hop}`), to: f.ref(`P${index}-${hop + 1}`), relationshipType: v.link, evidenceRefs: [] })) }));
    const stored = storedAskResultOf(f.answered({ templateId: 'shortest-paths', result: { status: 'ok', paths: many, nodes: [], edges: [], capReached: true, partial: false, elapsedMs: 1, warnings: [] } }), false);
    expect(stored?.paths.length).toBeLessThanOrEqual(25);
    expect(stored?.paths.every((path) => path.steps.length === 4)).toBe(true);
    expect(stored?.omitted.paths).toBe(30 - (stored?.paths.length ?? 0));
    expect(storedAskResultSchema.safeParse(stored).success).toBe(true);
    expect(stored?.pathCut).toEqual({ capReached: true, partial: false });
    const distinct = new Set(stored?.paths.flatMap((path) => path.steps.flatMap((step) => [step.from, step.to])).map((end) => JSON.stringify(end)));
    expect(distinct.size).toBeLessThanOrEqual(ASK_RESULT_REFS_MAX);
  });

  it('keeps the completeness of a cut path answer apart from what the thread omits', () => {
    const stored = storedAskResultOf(f.answered({ templateId: 'shortest-paths', result: { status: 'ok', paths: [], nodes: [], edges: [], capReached: false, partial: true, retained: 2, requested: 5, elapsedMs: 1, warnings: [] } }, { outcome: 'partial' }), false);
    expect(stored).toMatchObject({ outcome: 'partial', pathCut: { partial: true, retained: 2, requested: 5 }, omitted: { paths: 0 } });
  });

  it('merges the notices by code in the order of the codes, without repeats, never loses a distinct code, and counts the payload entries it cuts', () => {
    const entities = Array.from({ length: 40 }, (_, index) => f.ref(`sx${index}`));
    const notices = [{ code: 'readBounded' }, { code: 'windowNotApplied', relationshipTypes: ['A', 'B'] }, { code: 'noStopList' }, { code: 'windowNotApplied', relationshipTypes: ['B', 'C'] }, { code: 'readBounded' }, { code: 'supernodesSkipped', entities }, { code: 'undatedExcluded' }, { code: 'evidenceCut' }, { code: 'stopListSkipped' }, { code: 'noStopList' }];
    const stored = storedAskResultOf(f.answered({ templateId: 'shared-attribute', result: { status: 'ok', count: exact(1), matchIds: [], nodes: [], edges: [], notices, warnings: [] } }), false);
    expect(stored?.notices.map((notice) => notice.code)).toEqual(['stopListSkipped', 'noStopList', 'undatedExcluded', 'readBounded', 'evidenceCut', 'windowNotApplied', 'supernodesSkipped']);
    expect(stored?.notices.find((notice) => notice.code === 'windowNotApplied')).toEqual({ code: 'windowNotApplied', relationshipTypes: ['A', 'B', 'C'] });
    const skipped = stored?.notices.find((notice) => notice.code === 'supernodesSkipped');
    expect(skipped && 'entities' in skipped ? skipped.entities.length : 0).toBe(ASK_RESULT_NOTICE_ENTRIES_MAX);
    expect(stored?.omitted.noticeEntries).toBe(40 - ASK_RESULT_NOTICE_ENTRIES_MAX);
  });

  it('stores nothing for a refusal and no element for a derived rule run or a shared attribute', () => {
    expect(storedAskResultOf({ refused: { cause: 'no-intent', sentence: 'No.' } } as unknown as AskAnswer, false)).toBeUndefined();
    const rule = kinds.find(([name]) => name === 'derived-rule-run')?.[1] as AskAnswer;
    expect(storedAskResultOf(rule, false)).toMatchObject({ rows: [], paths: [] });
    const shared = kinds.find(([name]) => name === 'shared-attribute')?.[1] as AskAnswer;
    expect(storedAskResultOf(shared, false)).toMatchObject({ rows: [], lines: [] });
  });
});

describe('the strict stored result', () => {
  it('refuses a free member, a block over the bound of references, and takes an answer without the block', () => {
    const base = { kind: 'ask-result', templateId: 'entity', outcome: 'complete', values: [], lines: [], rows: [], paths: [], notices: [], omitted: { rows: 0, paths: 0, lines: 0, noticeEntries: 0 } };
    expect(storedAskResultSchema.safeParse(base).success).toBe(true);
    expect(storedAskResultSchema.safeParse({ ...base, title: 'x' }).success).toBe(false);
    const refs = Array.from({ length: ASK_RESULT_REFS_MAX + 1 }, (_, index) => ({ form: 'ref', ref: { sourceId: 's', entityType: 't', stableId: `rx${index}` } }));
    expect(storedAskResultSchema.safeParse({ ...base, rows: refs.slice(0, 25) }).success).toBe(true);
    expect(storedAskResultSchema.safeParse({ ...base, rows: refs }).success).toBe(false);
  });
});
