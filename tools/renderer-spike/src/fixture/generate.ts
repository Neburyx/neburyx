import { z } from 'zod';
import { FixtureError } from './errors.js';
import { createRandom, pickIndex, type Random } from './random.js';
import { additionsSchema, fixtureSchema, type Additions, type EntityType, type Fixture, type FixtureNode, type FixtureRelationship } from './schema.js';

type EntityNode = Extract<FixtureNode, { kind: 'entity' }>;

export const DEFAULT_ELEMENTS = 300;
export const MIN_ELEMENTS = 30;
export const MAX_ELEMENTS = 2000;
export const NEIGHBOR_AGGREGATE_TOTAL = 3000;

const NODE_SHARE = 0.4;
const DERIVED_SHARE = 0.12;
const HUB_PREFERENCE = 0.25;
const MIN_MEMBERS = 3;
const MAX_MEMBERS = 60;
const MAX_PLACE_ATTEMPTS = 1000;

const parametersSchema = z.strictObject({
  seed: z.number().int().nonnegative(),
  elements: z.number().int().min(MIN_ELEMENTS).max(MAX_ELEMENTS).default(DEFAULT_ELEMENTS),
});

export type FixtureParameters = z.input<typeof parametersSchema>;

const TYPES: readonly EntityType[] = [
  { id: 'type-a', displayName: 'Type A', iconKey: 'circle' },
  { id: 'type-b', displayName: 'Type B', iconKey: 'square' },
  { id: 'type-c', displayName: 'Type C', iconKey: 'triangle' },
  { id: 'type-d', displayName: 'Type D', iconKey: 'diamond' },
];
const RELATIONSHIP_TYPES = ['rel-a', 'rel-b', 'rel-c'] as const;
const STATES = ['open', 'review', 'closed'] as const;
const HUB_TYPE = 'type-a';
const NEIGHBOR_TYPE = 'type-c';
const ORDINARY_TYPES = ['type-a', 'type-b', 'type-c', 'type-d'] as const;

function parseParameters(input: unknown): z.output<typeof parametersSchema> {
  const parsed = parametersSchema.safeParse(input);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const parameter = first?.path[0];
  throw new FixtureError('FIXTURE_PARAMETER_INVALID', typeof parameter === 'string' ? parameter : 'parameters');
}

function nodeId(index: number): string {
  return `n-${String(index).padStart(4, '0')}`;
}

function relationshipId(index: number): string {
  return `r-${String(index).padStart(4, '0')}`;
}

function pairKey(from: string, to: string, type: string): string {
  return `${from}|${to}|${type}`;
}

function buildNodes(count: number, random: Random): EntityNode[] {
  const nodes: EntityNode[] = [];
  for (let index = 0; index < count; index += 1) {
    const type = index === 0 ? HUB_TYPE : (ORDINARY_TYPES[pickIndex(random, ORDINARY_TYPES.length)] ?? HUB_TYPE);
    const state = STATES[pickIndex(random, STATES.length)] ?? 'open';
    nodes.push({ kind: 'entity', id: nodeId(index), type, label: `${type.slice(-1).toUpperCase()}-${String(index).padStart(4, '0')}`, state });
  }
  return nodes;
}

export function generateFixture(input: FixtureParameters): Fixture {
  const { seed, elements } = parseParameters(input);
  const random = createRandom(seed);
  const nodeTotal = Math.round(elements * NODE_SHARE);
  const relationshipTotal = elements - nodeTotal;
  const entities = buildNodes(nodeTotal, random);
  const hubId = nodeId(0);
  const aggregateId = nodeId(1);

  const relationships: FixtureRelationship[] = [];
  const used = new Set<string>();
  const add = (kind: 'sourced' | 'derived', from: string, to: string, type: string): void => {
    used.add(pairKey(from, to, type));
    relationships.push({ kind, id: relationshipId(relationships.length), type, from, to });
  };
  const relationshipType = (): string => RELATIONSHIP_TYPES[pickIndex(random, RELATIONSHIP_TYPES.length)] ?? 'rel-a';

  add('sourced', hubId, aggregateId, 'rel-a');
  for (let index = 2; index < nodeTotal; index += 1) {
    const parent = index === 2 || random() < HUB_PREFERENCE ? 0 : 2 + pickIndex(random, index - 2);
    add('sourced', nodeId(parent), nodeId(index), relationshipType());
  }

  const ordinary = entities.slice(2);
  const pickOrdinary = (): string => ordinary[pickIndex(random, ordinary.length)]?.id ?? hubId;
  const place = (kind: 'sourced' | 'derived'): void => {
    for (let attempt = 0; attempt < MAX_PLACE_ATTEMPTS; attempt += 1) {
      const from = pickOrdinary();
      const to = pickOrdinary();
      const type = relationshipType();
      if (from === to || used.has(pairKey(from, to, type)) || used.has(pairKey(to, from, type))) continue;
      add(kind, from, to, type);
      return;
    }
    throw new FixtureError('FIXTURE_PARAMETER_INVALID', 'elements');
  };

  let aggregateFrom = pickOrdinary();
  let aggregateTo = pickOrdinary();
  while (aggregateTo === aggregateFrom) aggregateTo = pickOrdinary();
  const members = MIN_MEMBERS + pickIndex(random, MAX_MEMBERS - MIN_MEMBERS);
  relationships.push({ kind: 'aggregate', id: relationshipId(relationships.length), type: 'rel-b', from: aggregateFrom, to: aggregateTo, members: { value: members, quality: 'exact', scope: 'members of this relationship type between the two entities' } });
  used.add(pairKey(aggregateFrom, aggregateTo, 'rel-b'));

  const derivedTotal = Math.round((relationshipTotal - relationships.length) * DERIVED_SHARE);
  for (let index = 0; index < derivedTotal; index += 1) place('derived');
  while (relationships.length < relationshipTotal) place('sourced');

  const neighborIds = new Set(ordinary.filter((node) => node.type === NEIGHBOR_TYPE).map((node) => node.id));
  const loaded = relationships.filter((relationship) => relationship.from === hubId && neighborIds.has(relationship.to)).length;
  const aggregate: FixtureNode = { kind: 'neighborAggregate', id: aggregateId, type: NEIGHBOR_TYPE, supernodeId: hubId, loaded, total: { value: NEIGHBOR_AGGREGATE_TOTAL, quality: 'lowerBound', scope: 'neighbors of the supernode of this type' } };
  const nodes: FixtureNode[] = [entities[0] ?? aggregate, aggregate, ...ordinary];

  const checked = fixtureSchema.safeParse({ seed, types: [...TYPES], nodes, relationships });
  if (!checked.success) throw new FixtureError('FIXTURE_INVALID');
  return checked.data;
}

export function parseFixture(input: unknown): Fixture {
  const parsed = fixtureSchema.safeParse(input);
  if (!parsed.success) throw new FixtureError('FIXTURE_INVALID');
  return parsed.data;
}

export const ADDED_NODES = 25;
const MAX_ADDED = 200;

const additionsParametersSchema = z.strictObject({ seed: z.number().int().nonnegative(), count: z.number().int().min(1).max(MAX_ADDED).default(ADDED_NODES) });

export type AdditionsParameters = z.input<typeof additionsParametersSchema>;

/** New entity nodes, each joined to one existing entity node (never the neighbor aggregate) by a sourced relationship. */
export function generateAdditions(fixture: Fixture, input: AdditionsParameters): Additions {
  const parsed = additionsParametersSchema.safeParse(input);
  if (!parsed.success) throw new FixtureError('FIXTURE_PARAMETER_INVALID', typeof parsed.error.issues[0]?.path[0] === 'string' ? String(parsed.error.issues[0]?.path[0]) : 'parameters');
  const { seed, count } = parsed.data;
  const random = createRandom(seed + 1);
  const anchors = fixture.nodes.filter((node) => node.kind === 'entity');
  const types = ORDINARY_TYPES;
  const nodes: EntityNode[] = [];
  const relationships: Additions['relationships'] = [];
  for (let index = 0; index < count; index += 1) {
    const type = types[pickIndex(random, types.length)] ?? HUB_TYPE;
    const id = `a-${String(index).padStart(4, '0')}`;
    nodes.push({ kind: 'entity', id, type, label: `${type.slice(-1).toUpperCase()}-${id.slice(2)}`, state: STATES[pickIndex(random, STATES.length)] ?? 'open' });
    const anchor = anchors[pickIndex(random, anchors.length)] ?? anchors[0];
    relationships.push({ kind: 'sourced', id: `ar-${String(index).padStart(4, '0')}`, type: relationshipTypeFor(random), from: anchor?.id ?? nodeId(0), to: id });
  }
  const checked = additionsSchema.safeParse({ nodes, relationships });
  if (!checked.success) throw new FixtureError('FIXTURE_INVALID');
  return checked.data;
}

function relationshipTypeFor(random: Random): string {
  return RELATIONSHIP_TYPES[pickIndex(random, RELATIONSHIP_TYPES.length)] ?? 'rel-a';
}
