import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JUDGE_MODULE, createCheckRunner, judgeSentences, parseJudged, type JudgeInput } from '@neburyx/ee-ai-runtime';
import { sentencesOfBlocks, type AssistantBlocks, type GraphEdge, type GraphNode, type SummaryReading } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { assembleResults } from '../assistant/tool-answer.js';
import { judgeTableRows } from '../assistant/table.js';
import { removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_BODY, answerOf, nodeOf, ok, okResult, rig } from '../testing/assistant-rig.js';
import { assembleText } from './assemble.js';
import { checkedTextOf, judgeCheck } from './judge.js';
import { rejudge } from './rejudge.js';

afterAll(removeAskFolders);

/** The names a comparison needs, read from a shipped mapping: an entity type with a filterable property, that property, another entity type, and a relationship type. No name of a pack is written here. */
function namesOf(pack: string): { item: string; holder: string; link: string; property: string; words: string } {
  const mapping = readFileSync(fileURLToPath(new URL(`../../../../domain-packs/${pack}/neburyx.yaml`, import.meta.url)), 'utf8');
  const [entities = '', relationships = ''] = mapping.split(/^ +relationships:$/mu);
  const blocks = entities.split(/^ +- type: /mu).slice(1);
  const withProperty = blocks.find((block) => /^ +filterable: \[\w+/mu.test(block)) ?? '';
  const item = withProperty.split('\n')[0] ?? '';
  const holder = blocks.map((block) => block.split('\n')[0] ?? '').find((type) => type !== item) ?? '';
  const property = /^ +filterable: \[(\w+)/mu.exec(withProperty)?.[1] ?? '';
  const link = /^ +- type: (\w+)/mu.exec(relationships)?.[1] ?? '';
  return { item, holder, link, property, words: property.replace(/([a-z])([A-Z])/gu, '$1 $2').toLowerCase() };
}

const PACKS = ['banking-fraud', 'insurance-claims'].map((pack) => ({ pack, ...namesOf(pack) }));

type Property = GraphNode['properties'][number];

describe.each(PACKS)('comparison claims on the answer paths, with the words of $pack', ({ item, holder, link, property, words }) => {
  it('reads the names it needs from the mapping', () => {
    for (const name of [item, holder, link, property]) expect(name).toMatch(/^\w+$/u);
  });

  const ref = (entityType: string, stableId: string) => ({ sourceId: 'demo', entityType, stableId });
  const node = (entityType: string, stableId: string, properties: Property[] = []): GraphNode => ({ ref: ref(entityType, stableId), display: { title: `Item ${stableId}`, type: entityType }, properties, qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
  const held = (value: unknown, masked = false): Property => ({ key: property, value, dataClass: 'text', masked });
  const edge = (from: string, to: string): GraphEdge => ({ ref: { sourceId: 'demo', type: link, stableId: `${from}-${to}` } as never, type: link, from: ref(item, from), to: ref(holder, to), semantics: 'stored', properties: [], provenanceRefs: [], qualityFlags: [], authorization: { canInspect: true, canExport: true } }) as never;
  const reading = (second: Property = held('alpha'), to = 'H1'): SummaryReading => ({ nodes: [node(item, 'A', [held('alpha')]), node(item, 'B', [second]), node(holder, 'H1'), node(holder, 'H2')], edges: [edge('A', 'H1'), edge('B', to)], unresolved: 0, omitted: false, notRetrieved: { value: 0, quality: 'exact', scope: 'coverage' }, uncounted: 0 });
  const keysOf = (text: ReturnType<typeof assembleText>): { items: string[]; links: string[] } => ({
    items: [...text.keys].filter(([, element]) => element.kind === 'entity' && element.ref.entityType === item).map(([key]) => key),
    links: [...text.keys].filter(([, element]) => element.kind === 'relationship').map(([key]) => key),
  });
  const kept = (text: ReturnType<typeof assembleText>, sentence: string, cites: string[]): boolean => judgeSentences([{ text: sentence, cites }], checkedTextOf(text)).kept.length === 1;

  const SAME = `These two have the same ${words}.`;
  const DIFFERENT = `These two have different ${words}s.`;
  const SHARE = `These two ${item}s share a ${holder}.`;

  it('keeps a true claim of each kind and removes a false one over the text of the summary and of the view answer', () => {
    const alike = assembleText(reading());
    const apart = assembleText(reading(held('beta'), 'H2'));
    const { items, links } = keysOf(alike);
    for (const [text, sentence, cites, expected] of [
      [alike, SAME, items, true], [apart, SAME, items, false],
      [apart, DIFFERENT, items, true], [alike, DIFFERENT, items, false],
      [alike, SHARE, links, true], [apart, SHARE, links, false],
    ] as const) expect(kept(text, sentence, [...cites]), sentence).toBe(expected);
  });

  it('hands the check each value as it was sent, a masked one as its mask and marked, so that it decides no claim', () => {
    const text = assembleText(reading(held('a***', true)));
    const checked = checkedTextOf(text);
    const { items } = keysOf(text);
    expect(checked.elementValues?.get(items[1] ?? '')).toContainEqual({ key: property, text: 'a***', masked: true });
    expect(JSON.stringify([...(checked.elementValues ?? [])])).not.toContain('beta');
    expect(kept(text, SAME, items)).toBe(false);
    expect(kept(text, DIFFERENT, items)).toBe(false);
  });

  it('judges the same claims over the lines of a read', () => {
    const lines = (second: string) => assembleResults([], assembleText(reading(held(second), second === 'alpha' ? 'H1' : 'H2'))).assembled;
    const alike = lines('alpha');
    expect(checkedTextOf(alike).elementValues?.size).toBeGreaterThan(0);
    expect(kept(alike, SAME, keysOf(alike).items)).toBe(true);
    expect(kept(lines('beta'), SAME, keysOf(alike).items)).toBe(false);
  });

  it('judges a row of a table by the same rule', async () => {
    const text = assembleText(reading(held('beta')));
    const { items } = keysOf(text);
    const judge = (row: string) => judgeTableRows({ rows: [{ text: row, cites: items }], columns: undefined, checks: createCheckRunner({ thresholdMs: 60_000 }), judge: judgeCheck, text: checkedTextOf(text), timeoutMs: 5000, signal: new AbortController().signal, drop: () => false });
    expect(await judge(SAME)).toMatchObject({ kept: [], rejected: [{ reason: 'comparison' }] });
    expect(await judge(DIFFERENT)).toMatchObject({ removed: 0, positions: [0] });
  });

  it('gives the same verdicts in a worker thread', async () => {
    const text = assembleText(reading(held('beta')));
    const { items } = keysOf(text);
    const input: JudgeInput = { sentences: [{ text: SAME, cites: items }, { text: DIFFERENT, cites: items }], text: checkedTextOf(text) };
    let now = 0;
    const runner = createCheckRunner({ thresholdMs: 1, clock: () => now });
    const check = { name: 'comparison-judge', inline: (value: JudgeInput) => ((now += 100), judgeSentences(value.sentences, value.text)), module: JUDGE_MODULE, parse: parseJudged };
    const inPlace = await runner.run(check, input, { timeoutMs: 10_000 });
    const inWorker = await runner.run(check, input, { timeoutMs: 10_000 });
    expect(inPlace).toMatchObject({ status: 'done', value: { removed: 1 } });
    expect(inWorker).toEqual(inPlace);
  });

  it('judges a drafted claim again over the current reading, and drops it when a value changed or is masked now', () => {
    const drafted = assembleText(reading());
    const { items } = keysOf(drafted);
    const inputs = items.map((key) => ({ key, kind: 'entity', ref: drafted.keys.get(key)?.ref }));
    const again = (current: SummaryReading) => rejudge({ sentences: [{ text: SAME, cites: items }], inputRefs: inputs, mask: true } as never, current).kept.length;
    expect(again(reading())).toBe(1);
    expect(again(reading(held('beta')))).toBe(0);
    expect(again(reading(held('a***', true)))).toBe(0);
  });
});

describe('the elements a read listed', () => {
  const listed = (second: string) => {
    const base = okResult();
    if (!('status' in base.result) || base.result.status !== 'ok' || !('nodes' in base.result)) throw new Error('a read with a result');
    const nodes = base.result.nodes.map((each, index) => ({ ...each, properties: [{ key: 'colour', value: index === 0 ? 'green' : second, dataClass: 'text' as const, masked: index !== 0 && second === 'g***' }] }));
    return assembleResults([{ tool: 'shared', result: { ...base, result: { ...base.result, nodes } } as typeof base }]).assembled;
  };
  const kept = (second: string): number => judgeSentences([{ text: 'These two have the same colour.', cites: ['r1', 'r2'] }], checkedTextOf(listed(second))).kept.length;

  it('hand the check their values, a masked one marked, and are judged by them', () => {
    expect(kept('green')).toBe(1);
    expect(kept('red')).toBe(0);
    expect(checkedTextOf(listed('g***')).elementValues?.get('r2')).toContainEqual({ key: 'colour', text: 'g***', masked: true });
    expect(kept('g***')).toBe(0);
  });
});

describe('the view answer of the Assistant', () => {
  const nodes = (second: string) => () => ['A-1', 'A-2'].map((id, index) => ({ ...nodeOf(id), properties: [{ key: 'colour', value: index === 0 ? 'green' : second, dataClass: 'text' as const, masked: false }] }));
  const answered = async (second: string) => {
    const readNodes = nodes(second) as unknown as NonNullable<NonNullable<Parameters<typeof rig>[0]>['readNodes']>;
    const t = await rig({ readNodes, view: ok(JSON.stringify({ sentences: [{ text: 'These two have the same colour.', cites: ['n1', 'n2'] }, { text: 'Account A-1 is listed.', cites: ['n1'] }] })) });
    const answer = await answerOf(t.route.handler(t.request(VIEW_BODY)));
    return answer.status === 'answered' && 'blocks' in answer ? sentencesOfBlocks(answer.blocks as AssistantBlocks).map((sentence) => sentence.text) : [];
  };

  it('keeps the claim when the elements read for the turn show it, and removes it when they do not', async () => {
    expect(await answered('green')).toEqual(['These two have the same colour.', 'Account A-1 is listed.']);
    expect(await answered('red')).toEqual(['Account A-1 is listed.']);
  });
});
