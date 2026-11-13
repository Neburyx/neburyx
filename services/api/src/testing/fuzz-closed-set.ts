import { edgeRefSegmentOf, sourceLinkSegmentOf } from '@neburyx/contracts';
import { registeredRoutesOf } from '../app.js';
import { FUZZ_LINKED_PRESETS, FUZZ_SHARED_PRESETS, FUZZ_TIGHT_SOURCE, FUZZ_SOURCE, FUZZ_TEXT, allowedNames, type FuzzRig } from './fuzz-rig.js';

/** The names a statement quotes in backticks. */
export const quotedNamesOf = (cypher: string): string[] => [...cypher.matchAll(/`([^`]*)`/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

const jsonOf = (body: string): unknown => {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
};

/** Every `nextCursor`-like string in an answer. */
export function cursorsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(cursorsOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, entry]) => (key.toLowerCase().endsWith('cursor') && typeof entry === 'string' ? [entry] : cursorsOf(entry)));
}

/** Every `stableId` token (keyed) in an answer, with its entity type. */
export function tokensOf(value: unknown): { readonly entityType: string; readonly stableId: string }[] {
  if (Array.isArray(value)) return value.flatMap(tokensOf);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  const own = typeof record['entityType'] === 'string' && typeof record['stableId'] === 'string' && record['stableId'].startsWith('p1.') ? [{ entityType: record['entityType'], stableId: record['stableId'] }] : [];
  return [...own, ...Object.values(record).flatMap(tokensOf)];
}

/**
 * Runs every legal choice of each read route once, and keeps the statement text the executor saw: the closed set. Every choice names only what the mapping allows (entity types, relationship types,
 * directions, match modes, groups), so the set is every statement the gate can write for this mapping; a request of any other text must write nothing outside it.
 */
export async function closedSetOf(rig: FuzzRig): Promise<ReadonlySet<string>> {
  const set = await buildClosedSet(rig);
  routesOfClosedSet.set(set.statements, set.routes);
  const leaks = leaksOf(set.statements, set.values);
  if (leaks.length > 0) throw new Error(`the closed set holds request text: ${leaks.join('; ')}`);
  benignValuesOf.set(set.statements, set.values);
  return set.statements;
}

/** The routes (`METHOD /v1/pattern`) each closed set was built from: a route that is not here has no statement in the set, and a request to it in the fuzz would fail as "not in the closed set" only if it read the source. */
export const routesOfClosedSet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/** The registered route (`METHOD pattern`) a request URL goes to. */
export function routeKeyOf(rig: FuzzRig, method: 'GET' | 'POST', url: string): string {
  const path = url.split('?')[0] ?? url;
  const match = registeredRoutesOf(rig.app).find((route) => route.method === method && new RegExp(`^${route.url.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  if (match === undefined) throw new Error(`no registered route for ${method} ${path}`);
  return `${method} ${match.url}`;
}

/** The benign values each closed set was built from, for a test that checks the set for them. */
export const benignValuesOf = new WeakMap<ReadonlySet<string>, readonly string[]>();

async function buildClosedSet(rig: FuzzRig): Promise<{ readonly statements: Set<string>; readonly values: string[]; readonly routes: ReadonlySet<string> }> {
  const { app, executor } = rig;
  const routes = new Set<string>();
  const post = (url: string, payload: unknown) => {
    routes.add(routeKeyOf(rig, 'POST', url));
    return rig.post(url, payload);
  };
  const get = (url: string) => {
    routes.add(routeKeyOf(rig, 'GET', url));
    return app.inject({ method: 'GET', url });
  };
  /** A pattern run the closed set is built from: it must be served, so that what is left out of the set is left out on purpose and a legal run that broke is found here. */
  const served = async (url: string, payload: unknown): Promise<void> => {
    const response = await post(url, payload);
    if (response.statusCode !== 200) throw new Error(`the closed set expected ${url} to be served, and it answered ${response.statusCode}: ${JSON.stringify(payload)}`);
  };
  const statements = new Set<string>();
  const keep = (): void => {
    for (const call of executor.calls) statements.add(call.cypher);
    rig.reset();
  };
  const cursors: string[] = [];
  const expandCursors: { neighborType: string; cursor: string }[] = [];
  const keys: { entityType: string; stableId: string }[] = [];
  const anchor = { entityType: 'widget', stableId: 'W-1' };
  const windows = [undefined, { days: 30 }, { from: '2026-01-01', to: '2026-01-31' }];
  for (const preset of FUZZ_SHARED_PRESETS) {
    for (const window of windows) {
      for (const minShared of [undefined, 2]) {
        for (const mask of [undefined, true, false]) {
          await served(`/v1/templates/${preset.id}/run`, { sourceId: FUZZ_SOURCE, params: { ref: anchor, ...(window === undefined ? {} : { window }), ...(minShared === undefined ? {} : { minShared }) }, ...(mask === undefined ? {} : { mask }) });
          keep();
        }
      }
    }
  }
  for (const preset of FUZZ_SHARED_PRESETS) {
    for (const window of windows) {
      for (const minShared of [undefined, 2]) {
        for (const mask of [undefined, true, false]) {
          await served('/v1/templates/shared-attribute/run', { sourceId: FUZZ_SOURCE, params: { ref: anchor, attributeType: preset.bind.attribute, via: preset.bind.via, ...(window === undefined ? {} : { window }), ...(minShared === undefined ? {} : { minShared }) }, ...(mask === undefined ? {} : { mask }) });
          keep();
        }
      }
    }
  }
  /** The legal choices of a linked run: a target of another type is reached in one hop or two, and in the stored direction or both; a target of the anchor's own type only in two hops through a different type, so only in both directions. */
  const choicesOf = (own: boolean): { maxHops?: number; direction?: string; window?: unknown }[] =>
    (own ? [{ maxHops: 2, direction: 'both' }] : [undefined, 1, 2].flatMap((maxHops) => [undefined, 'out', 'both'].map((direction) => ({ ...(maxHops === undefined ? {} : { maxHops }), ...(direction === undefined ? {} : { direction }) })))).flatMap((choice) =>
      windows.map((window) => ({ ...choice, ...(window === undefined ? {} : { window }) })),
    );
  for (const preset of FUZZ_LINKED_PRESETS) {
    for (const choice of choicesOf(preset.bind.target === preset.bind.anchor)) {
      for (const mask of [undefined, true, false]) {
        await served(`/v1/templates/${preset.id}/run`, { sourceId: FUZZ_SOURCE, params: { ref: anchor, ...choice }, ...(mask === undefined ? {} : { mask }) });
        keep();
      }
    }
  }
  const linkedByType = [
    { targetType: 'gadget', via: ['MADE_FROM'] },
    { targetType: 'phone', via: ['USES'] },
    { targetType: 'widget', via: ['MADE_FROM'] },
  ];
  for (const bind of linkedByType) {
    for (const choice of choicesOf(bind.targetType === 'widget')) {
      for (const mask of [undefined, true]) {
        await served('/v1/templates/linked-entities/run', { sourceId: FUZZ_SOURCE, params: { ref: anchor, ...bind, ...choice }, ...(mask === undefined ? {} : { mask }) });
        keep();
      }
    }
  }
  for (const window of windows) {
    await served('/v1/templates/linked-entities/run', { sourceId: FUZZ_SOURCE, params: { ref: anchor, targetType: 'gadget', via: ['MADE_FROM', 'USES'], ...(window === undefined ? {} : { window }) } });
    keep();
  }
  /** The runs of the third source that are served: one hop under its budget of one, and the relationship with no time property without a window. */
  await served('/v1/templates/linked-gadgets/run', { sourceId: FUZZ_TIGHT_SOURCE, params: { ref: anchor, maxHops: 1 } });
  keep();
  await served('/v1/templates/linked-holders/run', { sourceId: FUZZ_TIGHT_SOURCE, params: { ref: anchor } });
  keep();
  for (const direction of [undefined, 'in', 'both']) {
    for (const window of windows) {
      await served('/v1/templates/linked-entities/run', { sourceId: FUZZ_SOURCE, params: { ref: { entityType: 'gadget', stableId: 'GD-0' }, targetType: 'widget', via: ['MADE_FROM'], ...(direction === undefined ? {} : { direction }), ...(window === undefined ? {} : { window }) } });
      keep();
    }
  }
  const types = [['gadget'], ['phone'], ['gadget', 'phone']];
  for (const neighborTypes of types) {
    for (const direction of ['out', 'in', 'both']) {
      for (const relTypes of [undefined, ['MADE_FROM'], ['USES'], ['MADE_FROM', 'USES']]) {
        for (const mask of [undefined, true, false]) {
          const response = await post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes, direction, ...(relTypes === undefined ? {} : { relTypes }), ...(mask === undefined ? {} : { mask }), limit: 2 });
          const body = jsonOf(response.body);
          for (const neighborType of neighborTypes) for (const cursor of cursorsOf(body).slice(0, 1)) expandCursors.push({ neighborType, cursor });
          keys.push(...tokensOf(body).slice(0, 1));
          keep();
        }
      }
    }
  }
  for (const entityTypes of [undefined, ['widget'], ['gadget'], ['phone'], ['widget', 'gadget']]) {
    for (const matchModes of [undefined, ['exact'], ['related'], ['evidence'], ['exact', 'related', 'evidence']]) {
      for (const mask of [undefined, true, false]) {
        const response = await post('/v1/search/entities', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, ...(entityTypes === undefined ? {} : { entityTypes }), ...(matchModes === undefined ? {} : { matchModes }), ...(mask === undefined ? {} : { mask }) });
        cursors.push(...cursorsOf(jsonOf(response.body)));
        keep();
      }
    }
  }
  for (const text of ['ne', 'needle']) {
    await post('/v1/search/entities', { sourceId: FUZZ_SOURCE, text, typeahead: true });
    keep();
  }
  for (const group of ['exact', 'related', 'evidence']) {
    for (const mask of [undefined, true]) {
      for (const entityTypes of [undefined, ['widget']]) {
        await post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group, cursor: 'v1.x.y', ...(mask === undefined ? {} : { mask }), ...(entityTypes === undefined ? {} : { entityTypes }) });
        keep();
      }
    }
  }
  for (const entityType of ['widget', 'gadget']) {
    const stableId = entityType === 'widget' ? 'W-1' : 'GD-0';
    await post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId } });
    keep();
    for (const mask of [undefined, true, false]) {
      await post('/v1/graph/derived-neighbors', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId }, ...(mask === undefined ? {} : { mask }) });
      keep();
      await post('/v1/graph/read-refs', { sourceId: FUZZ_SOURCE, entities: [{ sourceId: FUZZ_SOURCE, entityType, stableId }], ...(mask === undefined ? {} : { mask }) });
      keep();
    }
    await post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType, stableId } });
    keep();
    await post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, value: { entityType, value: stableId } });
    keep();
    await get(`/v1/entities/${FUZZ_SOURCE}/${entityType}/${stableId}` );
    keep();
  }
  await post('/v1/investigations', { sourceId: FUZZ_SOURCE, entity: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' } });
  keep();
  for (const mask of [undefined, 'true', 'false']) {
    await get(`/v1/edges/${edgeRefSegmentOf({ sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' })}${mask === undefined ? '' : `?mask=${mask}`}` );
    keep();
  }
  for (const mask of [undefined, 'true', 'false']) {
    const ref = { sourceId: FUZZ_SOURCE, derived: { ruleId: 'shared-gadget', from: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }, to: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-2' } } };
    await get(`/v1/edges/${edgeRefSegmentOf(ref)}${mask === undefined ? '' : `?mask=${mask}`}` );
    keep();
  }
  await get(`/v1/source-links/${sourceLinkSegmentOf({ form: 'entity', ref: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' } })}` );
  keep();
  await get(`/v1/source-links/${sourceLinkSegmentOf({ form: 'stored', ref: { sourceId: FUZZ_SOURCE, type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' } })}?record=R-1` );
  keep();
  for (const token of keys.filter((entry) => entry.entityType === 'phone').slice(0, 1)) {
    for (const mask of [undefined, 'true']) {
      const ref = { sourceId: FUZZ_SOURCE, aggregate: { type: 'USES', from: { sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }, to: { sourceId: FUZZ_SOURCE, ...token } } };
      await get(`/v1/edges/${edgeRefSegmentOf(ref)}${mask === undefined ? '' : `?mask=${mask}`}`);
      keep();
    }
  }
  for (const token of keys.slice(0, 1)) {
    await post('/v1/graph/preview-expansion', { sourceId: FUZZ_SOURCE, ref: { entityType: token.entityType, stableId: token.stableId } });
    keep();
    await post('/v1/entities/lookup', { sourceId: FUZZ_SOURCE, ref: { entityType: token.entityType, stableId: token.stableId } });
    keep();
  }
  for (const { neighborType, cursor } of expandCursors) {
    await post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: [neighborType], cursors: { [neighborType]: cursor }, limit: 2 });
    keep();
  }
  for (const cursor of cursors) {
    for (const group of ['exact', 'related', 'evidence']) {
      await post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group, cursor });
      keep();
    }
  }
  const exactRefSets = [[{ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }], [{ sourceId: FUZZ_SOURCE, entityType: 'widget', stableId: 'W-1' }, ...keys.slice(0, 1).map((entry) => ({ sourceId: FUZZ_SOURCE, ...entry }))]];
  for (const cursor of cursors) {
    for (const exactRefs of exactRefSets) {
      await post('/v1/search/entities/more', { sourceId: FUZZ_SOURCE, text: FUZZ_TEXT, group: 'related', cursor, exactRefs });
      keep();
    }
  }
  return { statements, routes, values: ['W-1', 'GD-0', 'L-1', '2026-01-01', '2026-01-31', FUZZ_TEXT, 'ne', '+1-212-555-01', ...cursors, ...expandCursors.map((entry) => entry.cursor), ...keys.map((entry) => entry.stableId)] };
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');

/** The benign values in a set of statements: a statement that holds a value used to build the set shows a template that wrote request text into its statement. */
export function leaksOf(statements: ReadonlySet<string>, values: readonly string[]): string[] {
  const found: string[] = [];
  for (const statement of statements) {
    for (const value of values) {
      if (new RegExp(`(^|[^A-Za-z0-9_$])${escaped(value)}([^A-Za-z0-9_]|$)`).test(statement)) found.push(`${value} in ${statement.slice(0, 80)}`);
    }
  }
  return found;
}

export interface StatementProblem {
  readonly cypher: string;
  readonly reason: string;
}

/**
 * What is wrong with the statements the executor saw: one outside the closed set, one that quotes a name the mapping does not allow, or one that holds a piece of the request's text. Empty when
 * every statement is a fixed template with allowlisted names.
 */
export function statementProblems(rig: FuzzRig, closed: ReadonlySet<string>, requestTexts: readonly string[]): StatementProblem[] {
  const names = allowedNames();
  const problems: StatementProblem[] = [];
  for (const call of rig.executor.calls) {
    if (!closed.has(call.cypher)) problems.push({ cypher: call.cypher, reason: 'not in the closed set' });
    for (const name of quotedNamesOf(call.cypher)) if (!names.has(name)) problems.push({ cypher: call.cypher, reason: `quotes ${JSON.stringify(name)}` });
    for (const text of requestTexts) if (call.cypher.includes(text)) problems.push({ cypher: call.cypher, reason: `holds request text ${JSON.stringify(text)}` });
  }
  return problems;
}
