import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { GraphNode, GraphProperty } from '@neburyx/contracts';
import { fakeClock, gateRequest, harness, testCatalog, testTemplate, TestExecutor } from '../testing/gate.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { plainNode, redactContext } from '../testing/normalize-fixtures.js';
import { firstSource } from '../testing/mapping.js';
import type { GateContext } from './types.js';
import { normalizeModelOf } from './normalize/model.js';
import { normalizeRows, type Normalized } from './normalize/index.js';
import { redactItems } from './redact/index.js';
import { styledItems, styleRulesOf } from './style-rules.js';

const rule = (id: string, when: Record<string, unknown>, effect: Record<string, unknown> = { badge: 'amber' }, appliesTo = 'gadget'): Record<string, unknown> => ({ id, label: id, applies_to: appliesTo, when, effect });

const source = (rules: Record<string, unknown>[]) =>
  firstSource(
    mappingOf(
      sourceWith('alpha', {
        entities: [
          {
            type: 'gadget',
            label: 'Gadget',
            stable_id: 'gadgetId',
            pii: ['secret_a'],
            filterable: ['score', 'seenAt', 'day', 'clock', 'flag', 'note'],
            kinds: { score: 'number', seenAt: 'dateTime', day: 'date', clock: 'time', flag: 'boolean', note: 'text' },
            display: { key_properties: ['status', 'score'] },
          },
          { type: 'person', label: 'Person', stable_id: 'personId', filterable: ['status'] },
        ],
        relationships: [{ type: 'MADE_BY', from: 'gadget', to: 'person' }],
        style_rules: rules,
      }),
    ),
  );

const property = (key: string, value: unknown, dataClass: GraphProperty['dataClass'], extra: Partial<GraphProperty> = {}): GraphProperty => ({ key, value, dataClass, masked: false, ...extra });
const nodeOf = (properties: GraphProperty[], entityType = 'gadget'): GraphNode => ({
  ref: { sourceId: 'alpha', entityType, stableId: 'g1' },
  display: { title: 'G', type: entityType },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const RULES = [
  rule('status-eq', { property: 'status', op: 'eq', value: 'review' }),
  rule('status-in', { property: 'status', op: 'in', value: ['review', 'held'] }, { color: 'red' }),
  rule('score-gt', { property: 'score', op: 'gt', value: 2000 }, { size: 'larger' }),
  rule('score-between', { property: 'score', op: 'between', value: [100, 5000] }, { icon: 'shield' }),
  rule('score-lte', { property: 'score', op: 'lte', value: 2450 }, { badge: 'gray' }),
  rule('seen-gte', { property: 'seenAt', op: 'gte', value: '2026-03-01T12:00:00Z' }, { badge: 'blue' }),
  rule('day-lt', { property: 'day', op: 'lt', value: '2026-03-01' }, { badge: 'green' }),
  rule('clock-lte', { property: 'clock', op: 'lte', value: '12:00:00Z' }, { badge: 'red' }),
  rule('flag-eq', { property: 'flag', op: 'eq', value: true }, { badge: 'amber' }),
  rule('person-status', { property: 'status', op: 'eq', value: 'review' }, { badge: 'amber' }, 'person'),
];
const model = normalizeModelOf(source(RULES));
const rulesOf = (type: string) => model.entitiesByType.get(type)?.styleRules ?? [];
const idsOf = (properties: GraphProperty[]) => styleRulesOf(nodeOf(properties), rulesOf('gadget'));

describe('which style rules a node matches', () => {
  it('matches each operator on the data class the node carries, in mapping order, and lists every match', () => {
    expect(idsOf([property('status', 'review', 'text'), property('score', '2450', 'number')])).toEqual(['status-eq', 'status-in', 'score-gt', 'score-between', 'score-lte']);
    expect(idsOf([property('status', 'held', 'text'), property('score', 99, 'number')])).toEqual(['status-in', 'score-lte']);
    expect(idsOf([property('score', '5000', 'number')])).toEqual(['score-gt', 'score-between']);
    expect(idsOf([property('score', '5000.5', 'number')])).toEqual(['score-gt']);
  });

  it('compares a tagged integer, a float and a number held as a JavaScript number by numeric value', () => {
    expect(idsOf([property('score', '2000.0', 'number')])).toEqual(['score-between', 'score-lte']);
    expect(idsOf([property('score', 2000.01, 'number')])).toEqual(['score-gt', 'score-between', 'score-lte']);
    expect(idsOf([property('score', '9007199254740993', 'number')])).toEqual(['score-gt']);
  });

  it('compares two dateTime values with different offsets as instants, and local values by their padded key', () => {
    expect(idsOf([property('seenAt', '2026-03-01T13:00:00+01:00', 'dateTime')])).toEqual(['seen-gte']);
    expect(idsOf([property('seenAt', '2026-03-01T11:59:59Z', 'dateTime')])).toEqual([]);
    expect(idsOf([property('day', '2026-02-28', 'date')])).toEqual(['day-lt']);
    expect(idsOf([property('day', '2026-03-01', 'date')])).toEqual([]);
    expect(idsOf([property('clock', '13:00:00+01:00', 'time')])).toEqual(['clock-lte']);
    expect(idsOf([property('clock', '12:00:01Z', 'time')])).toEqual([]);
  });

  it('never matches a value of another data class, an unreadable value, null, a list or a missing property, and coerces nothing', () => {
    expect(idsOf([property('status', 2450, 'number'), property('score', '2450', 'text'), property('flag', 'true', 'text')])).toEqual([]);
    expect(idsOf([property('score', 'many', 'number'), property('seenAt', 'soon', 'dateTime')])).toEqual([]);
    expect(idsOf([property('status', null, 'unknown'), property('score', ['1'], 'list'), property('flag', undefined, 'boolean')])).toEqual([]);
    expect(idsOf([])).toEqual([]);
  });

  it('matches a boolean only with a boolean', () => {
    expect(idsOf([property('flag', true, 'boolean')])).toEqual(['flag-eq']);
    expect(idsOf([property('flag', false, 'boolean')])).toEqual([]);
  });

  it('gives a masked property no match, whatever the cause and whatever the value, and the same ids for two different masked values', () => {
    const masked = (value: string): GraphProperty[] => [property('status', value, 'text', { masked: true, maskedBy: 'policy' }), property('score', '2450', 'number', { masked: true, maskedBy: 'request' })];
    expect(idsOf(masked('review'))).toEqual([]);
    expect(idsOf(masked('••••••'))).toEqual(idsOf(masked('anything else')));
    expect(idsOf([property('status', 'review', 'text', { masked: true })])).toEqual([]);
  });
});

describe('the style stage', () => {
  const context = (mask = false) => redactContext(model, mask);
  const normalized = (nodes: GraphNode[]): Normalized => ({ nodes, edges: [], unreferenced: [], counts: [], warnings: [] }) as unknown as Normalized;

  it('adds display.styleRules to a node that matches, and leaves a node that matches nothing, or whose type has no rule, exactly as it was', () => {
    const matching = nodeOf([property('status', 'review', 'text')]);
    const plain = nodeOf([property('status', 'ok', 'text')]);
    const other = nodeOf([property('status', 'review', 'text')], 'person');
    const [item] = styledItems([{ ...normalized([matching, plain, other]) }], context()) as unknown as Normalized[];
    expect(item?.nodes.map((node) => node.display.styleRules)).toEqual([['status-eq', 'status-in'], undefined, ['person-status']]);
    expect(Object.hasOwn(item?.nodes[1]?.display ?? {}, 'styleRules')).toBe(false);
    expect(item?.nodes[1]).toBe(plain);
  });

  it('passes an item that is not a normalized result through, and answers byte for byte as before for a source with no rules', () => {
    const items: Record<string, unknown>[] = [{ something: 'else' }, { ...normalized([nodeOf([property('status', 'review', 'text')])]) }];
    const bare = normalizeModelOf(source([]));
    expect(styledItems(items, redactContext(bare, false))).toEqual(items);
    expect((styledItems(items, context())[0] as unknown)).toBe(items[0]);
  });

  it('runs on the nodes after masking, so a policy-masked property gives no match with masking on and off', () => {
    const node = nodeOf([property('status', 'review', 'text', { masked: true, maskedBy: 'policy' })]);
    for (const mask of [false, true]) expect((styledItems([{ ...normalized([node]) }], context(mask))[0] as unknown as Normalized).nodes[0]?.display.styleRules).toBeUndefined();
  });

  it('never matches a rule on a personal-data property of the node, since load refuses such a rule and masking only adds', () => {
    const asked = normalizeModelOf(source(RULES));
    const redacted = redactItems([{ ...normalized([nodeOf([property('secret_a', 'Ana', 'text'), property('status', 'review', 'text')])]) }], redactContext(asked, true));
    const [item] = styledItems(redacted, redactContext(asked, true)) as unknown as Normalized[];
    expect(item?.nodes[0]?.properties.find((entry) => entry.key === 'secret_a')?.masked).toBe(true);
    expect(item?.nodes[0]?.display.styleRules).toEqual(['status-eq', 'status-in']);
  });
});

describe('the gate runs the style stage after the redact stage, whichever redact stage it has', () => {
  const dataTemplate = testTemplate({
    id: 'data-read',
    scope: 'user',
    paramsSchema: z.strictObject({}),
    normalize: (rows, _plan, context) => (context === undefined ? [] : [{ ...normalizeRows(context, rows) }]),
  });
  const row = plainNode(['Gadget'], { gadgetId: 'g-1', status: 'review', score: 2450 }, 'e1');

  function rig(redact?: (items: readonly Record<string, unknown>[], context: GateContext) => readonly Record<string, unknown>[]) {
    const clock = fakeClock(1_000_000);
    return harness({ catalog: testCatalog([dataTemplate]), modelFor: () => model, executor: new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ n: row }] })), clock: clock.now, ...(redact === undefined ? {} : { redact }) });
  }
  const idsOfPage = (page: { items: readonly Record<string, unknown>[] }): unknown => (page.items[0] as unknown as Normalized).nodes[0]?.display.styleRules;

  it('adds the ids with the standard redact stage, with masking on and off', async () => {
    const { gate } = rig();
    expect(idsOfPage(await gate.run(gateRequest({ templateId: 'data-read', params: {} })))).toEqual(['status-eq', 'status-in', 'score-gt', 'score-between', 'score-lte']);
    expect(idsOfPage(await gate.run(gateRequest({ templateId: 'data-read', params: {}, mask: true })))).toEqual(['status-eq', 'status-in', 'score-gt', 'score-between', 'score-lte']);
  });

  it('adds them as well when the redact stage is replaced, and a property that stage masks gives no match', async () => {
    const replaced = rig((items) => items.map((item) => ({ ...item, nodes: (item as unknown as Normalized).nodes.map((node) => ({ ...node, properties: node.properties.map((entry) => (entry.key === 'status' ? { ...entry, value: '••••••', masked: true, maskedBy: 'policy' as const } : entry)) })) })));
    expect(idsOfPage(await replaced.gate.run(gateRequest({ templateId: 'data-read', params: {} })))).toEqual(['score-gt', 'score-between', 'score-lte']);
  });

  it('sends the same statements with rules as without: a rule causes no read', async () => {
    const run = async (rules: Record<string, unknown>[]): Promise<string> => {
      const executor = new TestExecutor(() => Promise.resolve({ status: 'rows', rows: [{ n: row }] }));
      const withModel = normalizeModelOf(source(rules));
      const { gate } = harness({ catalog: testCatalog([dataTemplate]), modelFor: () => withModel, executor, clock: fakeClock(1_000_000).now });
      await gate.run(gateRequest({ templateId: 'data-read', params: {} }));
      return JSON.stringify(executor.calls);
    };
    const without = await run([]);
    expect(without).not.toBe('[]');
    expect(await run(RULES)).toBe(without);
  });
});
