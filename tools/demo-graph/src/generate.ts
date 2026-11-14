import { DefinitionError, type CompiledBlock, type Definition, type Issue } from './definition.js';
import type { MappingSource } from './mapping.js';
import { createRng, type Rng } from './rng.js';
import { DateRangeError, evaluate, type Value } from './rules.js';

interface GeneratedFile {
  readonly kind: 'entity' | 'relationship';
  readonly type: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly lines: readonly string[];
}

export interface Generated {
  readonly seed: number;
  /** The calendar day the dates are placed relative to (YYYY-MM-DD); absent when the dates are as the definition wrote them. */
  readonly buildDate?: string;
  readonly sourceId: string;
  readonly files: readonly GeneratedFile[];
}

type Properties = Record<string, Value>;

function propertiesOf(rules: CompiledBlock['properties'], index: number, rngs: ReadonlyMap<string, Rng>, shiftDays: number, at: string): Properties {
  const properties: Properties = {};
  for (const { key, rule } of rules) {
    const rng = rngs.get(key);
    if (rng === undefined) continue;
    let value: Value | undefined;
    try {
      value = evaluate(rule, { index, rng, shiftDays });
    } catch (error) {
      if (error instanceof DateRangeError) refuse(`${at}.properties.${key}`, error.message);
      throw error;
    }
    if (value !== undefined) properties[key] = value;
  }
  return properties;
}

function distinct(rng: Rng, how: number, pool: { readonly start: number; readonly count: number }): number[] {
  const wanted = Math.min(how, pool.count);
  const chosen = new Set<number>();
  while (chosen.size < wanted) chosen.add(pool.start + rng.between(0, pool.count - 1));
  return [...chosen].sort((left, right) => left - right);
}

function randomEdges(block: CompiledBlock, sizes: { readonly from: number; readonly to: number }, rng: Rng): [number, number][] {
  const fromRange = block.fromRange ?? { start: 0, count: sizes.from };
  const toRange = block.toRange ?? { start: 0, count: sizes.to };
  const edges: [number, number][] = [];
  if (block.perTo !== undefined) {
    for (let target = toRange.start; target < toRange.start + toRange.count; target++) {
      for (const source of distinct(rng, rng.between(block.perTo.min, block.perTo.max), fromRange)) edges.push([source, target]);
    }
    return edges;
  }
  const perFrom = block.perFrom ?? { min: 1, max: 1 };
  const supernodeOf = new Map<number, number>();
  for (const supernode of block.supernodes) {
    for (let source = supernode.from.start; source < supernode.from.start + supernode.from.count; source++) supernodeOf.set(source, supernode.to);
  }
  for (let source = fromRange.start; source < fromRange.start + fromRange.count; source++) {
    const hub = supernodeOf.get(source);
    if (hub !== undefined) edges.push([source, hub]);
    else for (const target of distinct(rng, rng.between(perFrom.min, perFrom.max), toRange)) edges.push([source, target]);
  }
  return edges;
}

function ringEdges(block: CompiledBlock): [number, number][] {
  const edges: [number, number][] = [];
  for (let group = 0; group < block.groups; group++) {
    for (let member = 0; member < block.size; member++) edges.push([block.fromStart + group * block.size + member, block.toStart + group]);
  }
  return edges;
}

function refuse(path: string, reason: string): never {
  const issue: Issue = { path, reason };
  throw new DefinitionError([issue]);
}

const DAY_MS = 86_400_000;

/** A calendar day as days since 1970-01-01 and back, for the build date. */
export const dayOf = (text: string): number | undefined => (/^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text ? Date.parse(`${text}T00:00:00Z`) / DAY_MS : undefined);

/**
 * Generates the data. With a build date (a calendar day), every date and time is moved by the whole days between the definition's reference date and the build date, so the pattern of days back from the end is kept and the end is the build date;
 * the draws of the seeded generator are the same. A definition with no reference date takes no build date.
 */
export function generate(mapping: MappingSource, definition: Definition, seed: number, buildDate?: string): Generated {
  let shiftDays = 0;
  if (buildDate !== undefined) {
    const built = dayOf(buildDate);
    if (built === undefined) refuse('build_date', 'needs a calendar day (YYYY-MM-DD)');
    if (definition.referenceDay === undefined) refuse('reference_date', 'is needed to place the dates relative to a build date');
    shiftDays = built - definition.referenceDay;
  }
  const files: GeneratedFile[] = [];
  const ids = new Map<string, string[]>();

  for (const entity of mapping.entities) {
    const compiled = definition.entities.find((candidate) => candidate.type === entity.type);
    if (compiled === undefined) continue;
    const rngs = new Map(compiled.properties.map(({ key }) => [key, createRng(seed, `entity:${entity.type}:${key}`)]));
    const lines: string[] = [];
    const typeIds: string[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < compiled.count; index++) {
      const properties = propertiesOf(compiled.properties, index, rngs, shiftDays, `entities.${entity.type}`);
      const id = properties[entity.stableId];
      if (typeof id !== 'string' || seen.has(id)) refuse(`entities.${entity.type}.properties.${entity.stableId}`, 'does not give every node its own identifier');
      seen.add(id);
      typeIds.push(id);
      lines.push(JSON.stringify({ p: properties }));
    }
    ids.set(entity.type, typeIds);
    files.push({ kind: 'entity', type: entity.type, label: entity.label, from: '', to: '', lines });
  }

  const relationshipIds = new Map<string, string>();
  for (const relationship of mapping.relationships) {
    const blocks = definition.blocks.filter((block) => block.type === relationship.type);
    if (blocks.length === 0) continue;
    const lines: string[] = [];
    const propertyKeys = [...new Set(blocks.flatMap((block) => block.properties.map((property) => property.key)))];
    const rngs = new Map(propertyKeys.map((key) => [key, createRng(seed, `relationship:${relationship.type}:${key}`)]));
    let edgeIndex = 0;
    blocks.forEach((block, blockIndex) => {
      const fromIds = ids.get(block.from) ?? [];
      const toIds = ids.get(block.to) ?? [];
      const rng = createRng(seed, `edges:${relationship.type}:${blockIndex}`);
      const edges = block.pattern === 'ring' ? ringEdges(block) : randomEdges(block, { from: fromIds.length, to: toIds.length }, rng);
      for (const [source, target] of edges) {
        const properties = propertiesOf(block.properties, edgeIndex, rngs, shiftDays, `relationships.${relationship.type}`);
        const identifier = relationship.stableId === undefined ? undefined : properties[relationship.stableId];
        if (relationship.stableId !== undefined) {
          const key = typeof identifier === 'string' ? identifier : '';
          if (key === '' || relationshipIds.has(key)) refuse(`relationships.${relationship.type}`, 'does not give every relationship its own identifier across relationship types');
          relationshipIds.set(key, relationship.type);
        }
        lines.push(JSON.stringify({ f: fromIds[source], t: toIds[target], p: properties }));
        edgeIndex += 1;
      }
    });
    files.push({ kind: 'relationship', type: relationship.type, label: '', from: relationship.from, to: relationship.to, lines });
  }
  return { seed, ...(buildDate === undefined ? {} : { buildDate }), sourceId: mapping.id, files };
}
