import { readFileSync } from 'node:fs';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type { MappingSource } from './mapping.js';
import { isIdentifierRule, type Rule, type Scalar } from './rules.js';

export interface Issue {
  readonly path: string;
  readonly reason: string;
}

export class DefinitionError extends Error {
  readonly issues: readonly Issue[];

  constructor(issues: readonly Issue[]) {
    super(`the demo definition is not usable:\n${issues.map((issue) => `  ${issue.path}: ${issue.reason}`).join('\n')}`);
    this.name = 'DefinitionError';
    this.issues = issues;
  }
}

const count = z.number().int().min(0);
const range = z.strictObject({ start: count, count: z.number().int().min(1) });
const edges = z.strictObject({ min: count, max: count });

const definitionSchema = z.strictObject({
  seed: z.number().int().min(0).optional(),
  entities: z.record(z.string(), z.strictObject({ count: z.number().int().min(1), properties: z.record(z.string(), z.unknown()) })),
  relationships: z
    .array(
      z.strictObject({
        type: z.string().min(1),
        from: z.string().min(1),
        to: z.string().min(1),
        pattern: z.enum(['random', 'ring']),
        perFrom: edges.optional(),
        perTo: edges.optional(),
        fromRange: range.optional(),
        toRange: range.optional(),
        supernodes: z.array(z.strictObject({ to: count, from: range })).optional(),
        groups: z.number().int().min(1).optional(),
        size: z.number().int().min(2).optional(),
        fromStart: count.optional(),
        toStart: count.optional(),
        properties: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});

export interface CompiledEntity {
  readonly type: string;
  readonly count: number;
  readonly properties: readonly { readonly key: string; readonly rule: Rule }[];
}

export interface CompiledBlock {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly pattern: 'random' | 'ring';
  readonly perFrom: { readonly min: number; readonly max: number } | undefined;
  readonly perTo: { readonly min: number; readonly max: number } | undefined;
  readonly fromRange: { readonly start: number; readonly count: number } | undefined;
  readonly toRange: { readonly start: number; readonly count: number } | undefined;
  readonly supernodes: readonly { readonly to: number; readonly from: { readonly start: number; readonly count: number } }[];
  readonly groups: number;
  readonly size: number;
  readonly fromStart: number;
  readonly toStart: number;
  readonly properties: readonly { readonly key: string; readonly rule: Rule }[];
}

export interface Definition {
  readonly seed: number;
  readonly entities: readonly CompiledEntity[];
  readonly blocks: readonly CompiledBlock[];
}

type Report = (path: string, reason: string) => void;

const KINDS: ReadonlySet<string> = new Set(['sequence', 'choice', 'int', 'decimal', 'date', 'datetime', 'join', 'cycle', 'byIndex']);
const WHOLE_NUMBER = /^-?\d+$/;
const MAX_SAFE_ISSUES = 50;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function isScalar(value: unknown): value is Scalar {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isIndex(value: unknown): value is number {
  return isWholeNumber(value) && value >= 0;
}

/** A 64-bit whole number written as a number within the safe range or as text. */
function bound(value: unknown): bigint | undefined {
  const parsed = isWholeNumber(value) ? BigInt(value) : typeof value === 'string' && WHOLE_NUMBER.test(value) ? BigInt(value) : undefined;
  return parsed !== undefined && parsed >= INT64_MIN && parsed <= INT64_MAX ? parsed : undefined;
}

function day(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== value ? undefined : time / 86_400_000;
}

function second(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isNaN(time) || new Date(time).toISOString().slice(0, 19) + 'Z' !== value ? undefined : time / 1000;
}

function onlyKeys(body: Record<string, unknown>, allowed: readonly string[], at: string, report: Report): boolean {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  for (const key of unknown) report(`${at}.${key}`, 'is not a known key');
  return unknown.length === 0;
}

function compile(raw: unknown, path: string, report: Report): Rule {
  const fallback: Rule = { kind: 'constant', value: '' };
  if (isScalar(raw)) return { kind: 'constant', value: raw };
  if (!isObject(raw)) {
    report(path, 'is not a value rule');
    return fallback;
  }
  const kinds = Object.keys(raw).filter((key) => KINDS.has(key));
  const extra = Object.keys(raw).filter((key) => !KINDS.has(key) && key !== 'missing' && key !== 'weights');
  if (kinds.length !== 1) {
    report(path, kinds.length === 0 ? 'names no known rule kind' : 'names more than one rule kind');
    return fallback;
  }
  for (const key of extra) report(`${path}.${key}`, 'is not a known key');
  const kind = kinds[0] ?? '';
  const missing = raw['missing'] === undefined ? 0 : raw['missing'];
  if (typeof missing !== 'number' || !Number.isFinite(missing) || missing < 0 || missing > 1) {
    report(`${path}.missing`, 'is not a probability between 0 and 1');
    return fallback;
  }
  if (raw['weights'] !== undefined && kind !== 'choice') report(`${path}.weights`, 'belongs to a choice rule only');
  const body = raw[kind];
  const at = `${path}.${kind}`;
  switch (kind) {
    case 'sequence': {
      if (!isObject(body) || !onlyKeys(body, ['prefix', 'width', 'start'], at, report)) break;
      const prefix = body['prefix'] ?? '';
      const width = body['width'] ?? 0;
      const start = body['start'] ?? 0;
      if (typeof prefix !== 'string' || !isIndex(width) || width > 20 || !isIndex(start)) {
        report(at, 'needs a text prefix, a width from 0 to 20 and a start of 0 or more');
        return fallback;
      }
      return { kind: 'sequence', prefix, width, start, missing };
    }
    case 'choice': {
      if (!Array.isArray(body) || body.length === 0 || !body.every(isScalar)) break;
      const weights = raw['weights'];
      let cumulative: number[] | undefined;
      if (weights !== undefined) {
        if (!Array.isArray(weights) || weights.length !== body.length || !weights.every((weight) => typeof weight === 'number' && Number.isFinite(weight) && weight > 0)) {
          report(`${path}.weights`, 'does not give one positive, finite weight for each choice');
          return fallback;
        }
        let total = 0;
        cumulative = weights.map((weight: number) => (total += weight));
      }
      return { kind: 'choice', values: body, cumulative, missing };
    }
    case 'int': {
      if (!isObject(body) || !onlyKeys(body, ['min', 'max'], at, report)) break;
      const min = bound(body['min']);
      const max = bound(body['max']);
      if (min === undefined || max === undefined || min > max) {
        report(at, 'needs 64-bit whole-number bounds (as text beyond the safe range) with the minimum not above the maximum');
        return fallback;
      }
      return { kind: 'int', min, max, missing };
    }
    case 'decimal': {
      if (!isObject(body) || !onlyKeys(body, ['min', 'max', 'places'], at, report)) break;
      const { min, max, places } = body;
      if (typeof min !== 'number' || typeof max !== 'number' || !Number.isFinite(min) || !Number.isFinite(max) || min > max || !isWholeNumber(places) || places < 1 || places > 6) {
        report(at, 'needs finite numeric bounds with the minimum not above the maximum and 1 to 6 places');
        return fallback;
      }
      const scale = 10 ** places;
      let low = Math.round(min * scale);
      if (low / scale < min) low += 1;
      let high = Math.round(max * scale);
      if (high / scale > max) high -= 1;
      if (low > high || !Number.isSafeInteger(low) || !Number.isSafeInteger(high)) {
        report(at, 'has no value with that many places between its bounds');
        return fallback;
      }
      return { kind: 'decimal', low, high, places, missing };
    }
    case 'date': {
      if (!isObject(body) || !onlyKeys(body, ['from', 'to'], at, report)) break;
      const fromDay = day(body['from']);
      const toDay = day(body['to']);
      if (fromDay === undefined || toDay === undefined || fromDay > toDay) {
        report(at, 'needs two calendar days (YYYY-MM-DD) with the first not after the second');
        return fallback;
      }
      return { kind: 'date', fromDay, toDay, missing };
    }
    case 'datetime': {
      if (!isObject(body) || !onlyKeys(body, ['from', 'to'], at, report)) break;
      const fromSecond = second(body['from']);
      const toSecond = second(body['to']);
      if (fromSecond === undefined || toSecond === undefined || fromSecond > toSecond) {
        report(at, 'needs two UTC times (YYYY-MM-DDTHH:MM:SSZ) with the first not after the second');
        return fallback;
      }
      return { kind: 'datetime', fromSecond, toSecond, missing };
    }
    case 'join': {
      if (!Array.isArray(body) || body.length === 0) break;
      return { kind: 'join', parts: body.map((part, index) => compile(part, `${at}[${index}]`, report)), missing };
    }
    case 'cycle': {
      if (!isObject(body) || !onlyKeys(body, ['values', 'every'], at, report)) break;
      const { values, every } = body;
      if (!Array.isArray(values) || values.length === 0 || !values.every(isScalar) || !isWholeNumber(every) || every < 1) {
        report(at, 'needs a list of values and a whole number of repeats of 1 or more');
        return fallback;
      }
      return { kind: 'cycle', values, every, missing };
    }
    case 'byIndex': {
      if (!isObject(body) || !onlyKeys(body, ['default', 'ranges'], at, report)) break;
      const ranges = body['ranges'] ?? [];
      if (!Array.isArray(ranges)) break;
      const compiled = ranges.flatMap((entry: unknown, index) => {
        const here = `${at}.ranges[${index}]`;
        if (!isObject(entry) || !onlyKeys(entry, ['from', 'to', 'rule'], here, report)) return [];
        const { from, to } = entry;
        if (!isIndex(from) || !isIndex(to) || from >= to) {
          report(here, 'needs a from index below its to index, both whole numbers of 0 or more');
          return [];
        }
        return [{ from, to, rule: compile(entry['rule'], `${here}.rule`, report) }];
      });
      return { kind: 'byIndex', fallback: body['default'] === undefined ? undefined : compile(body['default'], `${at}.default`, report), ranges: compiled, missing };
    }
    default:
      break;
  }
  report(at, 'does not have the shape of its rule kind');
  return fallback;
}

function compileProperties(raw: Readonly<Record<string, unknown>>, path: string, allowed: ReadonlySet<string>, report: Report) {
  return Object.entries(raw)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => {
      if (!allowed.has(key)) report(`${path}.${key}`, 'is not a property the mapping uses');
      return { key, rule: compile(value, `${path}.${key}`, report) };
    });
}

function inside(rangeValue: { readonly start: number; readonly count: number } | undefined, size: number): boolean {
  return rangeValue === undefined || rangeValue.start + rangeValue.count <= size;
}

export function parseDefinition(text: string, mapping: MappingSource): Definition {
  const issues: Issue[] = [];
  const report: Report = (path, reason) => {
    if (issues.length < MAX_SAFE_ISSUES) issues.push({ path, reason });
  };
  const document = parseDocument(text);
  if (document.errors.length > 0) throw new DefinitionError([{ path: 'file', reason: 'is not valid YAML' }]);
  let data: unknown;
  try {
    data = document.toJS();
  } catch {
    throw new DefinitionError([{ path: 'file', reason: 'is not valid YAML data (an alias that cannot be resolved or expanded)' }]);
  }
  const parsed = definitionSchema.safeParse(data);
  if (!parsed.success) {
    throw new DefinitionError(parsed.error.issues.map((issue) => ({ path: issue.path.join('.') || 'file', reason: 'does not have the shape of a demo definition' })));
  }
  const raw = parsed.data;
  const entityTypes = new Map(mapping.entities.map((entity) => [entity.type, entity]));
  const relationshipTypes = new Map(mapping.relationships.map((relationship) => [relationship.type, relationship]));

  const entities: CompiledEntity[] = [];
  for (const entity of mapping.entities) {
    const wanted = raw.entities[entity.type];
    if (wanted === undefined) continue;
    const properties = compileProperties(wanted.properties, `entities.${entity.type}.properties`, entity.properties, report);
    const identifier = properties.find((property) => property.key === entity.stableId);
    if (identifier === undefined) report(`entities.${entity.type}.properties.${entity.stableId}`, 'is the stable ID and has no rule');
    else if (!isIdentifierRule(identifier.rule)) report(`entities.${entity.type}.properties.${entity.stableId}`, 'is the stable ID and must be a sequence, never optional or random');
    entities.push({ type: entity.type, count: wanted.count, properties });
  }
  for (const type of Object.keys(raw.entities)) if (!entityTypes.has(type)) report(`entities.${type}`, 'is not an entity type of the mapping');

  const counts = new Map(entities.map((entity) => [entity.type, entity.count]));
  const blocks: CompiledBlock[] = (raw.relationships ?? []).map((block, index) => {
    const path = `relationships[${index}]`;
    const mapped = relationshipTypes.get(block.type);
    if (mapped === undefined) report(`${path}.type`, 'is not a relationship type of the mapping');
    else if (mapped.from !== block.from || mapped.to !== block.to) report(path, 'does not connect the entity types the mapping gives this relationship type');
    for (const end of ['from', 'to'] as const) if (!counts.has(block[end])) report(`${path}.${end}`, 'is an entity type the definition does not generate');
    const fromSize = counts.get(block.from) ?? 0;
    const toSize = counts.get(block.to) ?? 0;
    const properties = compileProperties(block.properties ?? {}, `${path}.properties`, mapped?.properties ?? new Set<string>(), report);
    if (mapped?.stableId !== undefined) {
      const identifier = properties.find((property) => property.key === mapped.stableId);
      if (identifier === undefined) report(`${path}.properties.${mapped.stableId}`, 'is the stable ID of this relationship type and has no rule');
      else if (!isIdentifierRule(identifier.rule)) report(`${path}.properties.${mapped.stableId}`, 'is the stable ID and must be a sequence, never optional or random');
    }
    if (block.pattern === 'random') {
      for (const [option, present] of [['groups', block.groups], ['size', block.size], ['fromStart', block.fromStart], ['toStart', block.toStart]] as const) {
        if (present !== undefined) report(`${path}.${option}`, 'belongs to a ring pattern only');
      }
      if ((block.perFrom === undefined) === (block.perTo === undefined)) report(path, 'needs exactly one of perFrom and perTo');
      for (const edge of [block.perFrom, block.perTo]) if (edge !== undefined && edge.min > edge.max) report(path, 'has a minimum of edges above its maximum');
      if (block.perTo !== undefined && (block.supernodes ?? []).length > 0) report(`${path}.supernodes`, 'cannot be combined with perTo');
      if (!inside(block.fromRange, fromSize)) report(`${path}.fromRange`, 'reaches past the entities that exist');
      if (!inside(block.toRange, toSize)) report(`${path}.toRange`, 'reaches past the entities that exist');
      const fromPool = block.fromRange ?? { start: 0, count: fromSize };
      const toPool = block.toRange ?? { start: 0, count: toSize };
      if (block.perFrom !== undefined && block.perFrom.max > toPool.count) report(`${path}.perFrom`, 'asks for more distinct targets than the target range holds');
      if (block.perTo !== undefined && block.perTo.max > fromPool.count) report(`${path}.perTo`, 'asks for more distinct sources than the source range holds');
      const seen: { start: number; end: number }[] = [];
      (block.supernodes ?? []).forEach((supernode, position) => {
        const here = `${path}.supernodes[${position}]`;
        if (supernode.to >= toSize) report(here, 'sends to a node that does not exist');
        const span = { start: supernode.from.start, end: supernode.from.start + supernode.from.count };
        if (span.start < fromPool.start || span.end > fromPool.start + fromPool.count) report(here, 'takes source nodes from outside the source range');
        if (seen.some((other) => span.start < other.end && other.start < span.end)) report(here, 'overlaps another supernode');
        seen.push(span);
      });
    } else {
      for (const [option, present] of [['perFrom', block.perFrom], ['perTo', block.perTo], ['fromRange', block.fromRange], ['toRange', block.toRange], ['supernodes', block.supernodes]] as const) {
        if (present !== undefined) report(`${path}.${option}`, 'belongs to a random pattern only');
      }
      if (block.groups === undefined || block.size === undefined || block.fromStart === undefined || block.toStart === undefined) report(path, 'needs groups, size, fromStart and toStart');
      else {
        if (block.fromStart + block.groups * block.size > fromSize) report(path, 'has ring members past the entities that exist');
        if (block.toStart + block.groups > toSize) report(path, 'has ring targets past the entities that exist');
      }
    }
    return {
      type: block.type,
      from: block.from,
      to: block.to,
      pattern: block.pattern,
      perFrom: block.perFrom,
      perTo: block.perTo,
      fromRange: block.fromRange,
      toRange: block.toRange,
      supernodes: block.supernodes ?? [],
      groups: block.groups ?? 0,
      size: block.size ?? 0,
      fromStart: block.fromStart ?? 0,
      toStart: block.toStart ?? 0,
      properties,
    };
  });
  for (const relationship of mapping.relationships) {
    if (relationship.stableId !== undefined) continue;
    for (const block of blocks.filter((candidate) => candidate.type === relationship.type)) {
      if (block.properties.some((property) => property.key === 'stable_id')) report(`relationships.${relationship.type}`, 'has no stable ID in the mapping');
    }
  }
  if (issues.length > 0) throw new DefinitionError(issues);
  return { seed: raw.seed ?? 0, entities, blocks };
}

export function readDefinition(path: string, mapping: MappingSource): Definition {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new DefinitionError([{ path: 'file', reason: 'cannot be read' }]);
  }
  return parseDefinition(text, mapping);
}
