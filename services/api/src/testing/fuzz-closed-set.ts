import { edgeRefSegmentOf, sourceLinkSegmentOf } from '@neburyx/contracts';
import { registeredRoutesOf } from '../app.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import type { SourceAllowlist } from '../gate/types.js';
import { learnedGrammar } from './pattern-grammar-fixture.js';
import { grammarProblems, type PatternGrammar } from './pattern-grammar.js';
import { makeToken } from '../reference/token.js';
import { expandWindowInstantsOf } from '../graph/expand-window.js';
import { windowInstantsOf } from '../graph/template-window.js';
import { TEST_REFERENCE_KEYS } from './gate.js';
import { FUZZ_PATTERN_STOPPED, FUZZ_PATTERN_SUPERNODE, FUZZ_HEAVY_ANCHOR, FUZZ_MAPPING, FUZZ_LINKED_PRESETS, FUZZ_SHARED_PRESETS, FUZZ_TIGHT_SOURCE, FUZZ_SOURCE, FUZZ_TEXT, allowedNames, type FuzzRig } from './fuzz-rig.js';

/** The text a pattern condition of the sample compares with: a benign value that no statement may hold. */
export const FUZZ_PATTERN_TEXT = 'zz-condition-text';

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
  casesOfClosedSet.set(set.statements, set.cases);
  patternStatementsOfClosedSet.set(set.statements, set.patternStatements);
  const leaks = leaksOf(set.statements, set.values);
  if (leaks.length > 0) throw new Error(`the closed set holds request text: ${leaks.join('; ')}`);
  const patternLeaks = leaksOf(set.patternStatements, set.values);
  if (patternLeaks.length > 0) throw new Error(`the pattern statements of the builder hold request text: ${patternLeaks.join('; ')}`);
  benignValuesOf.set(set.statements, set.values);
  return set.statements;
}

/** The routes (`METHOD /v1/pattern`) each closed set was built from: a route that is not here has no statement in the set, and a request to it in the fuzz would fail as "not in the closed set" only if it read the source. */
export const routesOfClosedSet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/**
 * The cases of a pattern run each closed set was built from, beyond its route, for each pattern template: `<template>:estimate` (a run that reads the estimate first, so the count statement is in the set) and `<template>:continue` (a run with
 * the continue flag, which reads no estimate). A test fails when a case is taken out.
 */
export const casesOfClosedSet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/** The pattern statements each closed set builder saw: they are not in the set (their text varies with the request) and each was accepted by the grammar of the compiler's words when it was seen. */
export const patternStatementsOfClosedSet = new WeakMap<ReadonlySet<string>, ReadonlySet<string>>();

/** The registered route (`METHOD pattern`) a request URL goes to. */
export function routeKeyOf(rig: FuzzRig, method: 'GET' | 'POST', url: string): string {
  const path = url.split('?')[0] ?? url;
  const match = registeredRoutesOf(rig.app).find((route) => route.method === method && new RegExp(`^${route.url.replace(/:[A-Za-z]+/g, '[^/]+')}$`).test(path));
  if (match === undefined) throw new Error(`no registered route for ${method} ${path}`);
  return `${method} ${match.url}`;
}

/** The benign values each closed set was built from, for a test that checks the set for them. */
export const benignValuesOf = new WeakMap<ReadonlySet<string>, readonly string[]>();

async function buildClosedSet(rig: FuzzRig): Promise<{ readonly statements: Set<string>; readonly values: string[]; readonly routes: ReadonlySet<string>; readonly cases: ReadonlySet<string>; readonly patternStatements: ReadonlySet<string> }> {
  const { app, executor } = rig;
  const patternStatements = new Set<string>();
  const routes = new Set<string>();
  const cases = new Set<string>();
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
    const id = url.split('/')[3] ?? '';
    const template = id === 'linked-entities' || FUZZ_LINKED_PRESETS.some((preset) => preset.id === id) || id.startsWith('linked-') ? 'linked-entities' : 'shared-attribute';
    const heavy = JSON.stringify(payload).includes(FUZZ_HEAVY_ANCHOR);
    cases.add(`${template}:${heavy ? 'heavy' : typeof payload === 'object' && payload !== null && 'continue' in payload && payload.continue === true ? 'continue' : 'estimate'}`);
    const response = await post(url, payload);
    if (response.statusCode !== 200) throw new Error(`the closed set expected ${url} to be served, and it answered ${response.statusCode}: ${JSON.stringify(payload)}`);
    if (heavy && (JSON.parse(response.body) as { status?: string }).status !== 'heavy') throw new Error(`the closed set expected ${url} to stop as heavy: ${response.body.slice(0, 120)}`);
  };
  const statements = new Set<string>();
  const keep = (): void => {
    for (const call of executor.calls) {
      // a statement of the pattern template is not in the set: it varies with the request, so it is checked against the grammar of the compiler's words instead
      if (call.templateId === 'pattern') {
        const found = grammarProblems(call.cypher, learnedGrammar(), patternAllowlistOf());
        if (found.length > 0) throw new Error(`the closed set expected a pattern statement the grammar accepts: ${found.join('; ')}\n${call.cypher}`);
        patternStatements.add(call.cypher);
      } else statements.add(call.cypher);
    }
    rig.reset();
  };
  const cursors: string[] = [];
  const expandCursors: { neighborType: string; cursor: string }[] = [];
  const keys: { entityType: string; stableId: string }[] = [];
  await get(`/v1/templates?sourceId=${FUZZ_SOURCE}`);
  keep();
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
    await served(`/v1/templates/${preset.id}/run`, { sourceId: FUZZ_SOURCE, params: { ref: anchor, limit: 10 }, continue: true });
    keep();
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
  for (const preset of FUZZ_LINKED_PRESETS) {
    await served(`/v1/templates/${preset.id}/run`, { sourceId: FUZZ_SOURCE, params: { ref: anchor, ...choicesOf(preset.bind.target === preset.bind.anchor)[0], limit: 10 }, continue: true });
    keep();
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
  /** The expansion of the third source, whose only relationship at a holder has no time property: a window over it is served and applies to nothing, and its statement is the same with or without the window. */
  const holder = { entityType: 'holder', stableId: makeToken(TEST_REFERENCE_KEYS, { sourceId: FUZZ_TIGHT_SOURCE, entityType: 'holder' }, 'H-1') };
  for (const window of [undefined, { days: 7 }]) {
    for (const direction of ['out', 'both']) {
      const response = await post('/v1/graph/expand', { sourceId: FUZZ_TIGHT_SOURCE, ref: holder, neighborTypes: ['widget'], direction, limit: 2, ...(window === undefined ? {} : { window }) });
      if (response.statusCode !== 200) throw new Error(`the closed set expected the expansion of the third source to be served, and it answered ${response.statusCode}`);
      keep();
    }
  }
  const heavyAnchor = { entityType: 'widget', stableId: FUZZ_HEAVY_ANCHOR };
  for (const [url, params] of [
    ['/v1/templates/shared-gadgets/run', { ref: heavyAnchor }],
    ['/v1/templates/shared-phones/run', { ref: heavyAnchor }],
    ['/v1/templates/shared-attribute/run', { ref: heavyAnchor, attributeType: 'gadget', via: 'MADE_FROM' }],
    ['/v1/templates/linked-gadgets/run', { ref: heavyAnchor }],
    ['/v1/templates/linked-widgets/run', { ref: heavyAnchor, maxHops: 2, direction: 'both' }],
    ['/v1/templates/linked-entities/run', { ref: heavyAnchor, targetType: 'gadget', via: ['MADE_FROM'] }],
  ] as const) {
    await served(url, { sourceId: FUZZ_SOURCE, params });
    keep();
  }
  /**
   * The pattern runs of the closed set, a sample of shapes and not every statement the compiler can write: over the fuzz source one step out and in both directions, a node condition (a text `eq`) and a relationship condition, a window of each form,
   * two steps through a gadget (a type on a stop-list) and through a handle (none), four steps, and the reads that skip a supernode and an entity on a stop-list. Each run must be served.
   */
  const patternRun = async (steps: readonly unknown[], anchorId = 'W-1', mask?: boolean): Promise<void> => {
    cases.add('pattern:run');
    const response = await post('/v1/patterns/run', { sourceId: FUZZ_SOURCE, definition: { anchorType: 'widget', steps }, anchor: { entityType: 'widget', stableId: anchorId }, ...(mask === undefined ? {} : { mask }) });
    if (response.statusCode !== 200) throw new Error(`the closed set expected a pattern run to be served, and it answered ${response.statusCode}: ${JSON.stringify(steps)}`);
    if (executor.calls.some((call) => call.templateId === 'pattern-count')) cases.add('pattern:estimate');
    keep();
  };
  const made = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['MADE_FROM'], direction: 'out', arrivesAt: 'gadget', ...extra });
  const back = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['MADE_FROM'], direction: 'in', arrivesAt: 'widget', ...extra });
  const uses = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['USES'], direction: 'out', arrivesAt: 'phone', ...extra });
  const usedBy = (extra: Record<string, unknown> = {}) => ({ relationshipTypes: ['USES'], direction: 'in', arrivesAt: 'widget', ...extra });
  const tierIs = { on: 'neighbor', property: 'tier', op: 'eq', value: { kind: 'text', value: FUZZ_PATTERN_TEXT } };
  const gradeIs = { on: 'relationship', property: 'grade', op: 'eq', value: { kind: 'text', value: FUZZ_PATTERN_TEXT } };
  for (const mask of [undefined, true, false]) {
    for (const direction of ['out', 'both']) await patternRun([made({ direction })], 'W-1', mask);
    await patternRun([made({ conditions: [tierIs] })], 'W-1', mask);
    await patternRun([made({ conditions: [gradeIs] })], 'W-1', mask);
    for (const window of windows) {
      if (window !== undefined) await patternRun([made({ window, conditions: [tierIs, gradeIs] })], 'W-1', mask);
    }
    await patternRun([made(), back()], 'W-1', mask);
    await patternRun([made({ window: { days: 30 } }), back({ window: { from: '2026-01-01', to: '2026-01-31' } })], 'W-1', mask);
    await patternRun([uses(), usedBy()], 'W-1', mask);
    await patternRun([made(), back(), uses(), usedBy()], 'W-1', mask);
  }
  await patternRun([made(), back()], FUZZ_PATTERN_SUPERNODE);
  await patternRun([made(), back()], FUZZ_PATTERN_STOPPED);
  /** A run for the anchor whose count is over the threshold stops as heavy (its count statement is in the set), and the same run with the continue flag reads no count and is served. */
  const heavyRun = await post('/v1/patterns/run', { sourceId: FUZZ_SOURCE, definition: { anchorType: 'widget', steps: [made(), back()] }, anchor: { entityType: 'widget', stableId: FUZZ_HEAVY_ANCHOR } });
  cases.add('pattern:heavy');
  if (heavyRun.statusCode !== 200 || (JSON.parse(heavyRun.body) as { status?: string }).status !== 'heavy') throw new Error(`the closed set expected a pattern run to stop as heavy: ${heavyRun.body.slice(0, 120)}`);
  keep();
  const continued = await post('/v1/patterns/run', { sourceId: FUZZ_SOURCE, definition: { anchorType: 'widget', steps: [made(), back()] }, anchor: { entityType: 'widget', stableId: FUZZ_HEAVY_ANCHOR }, continue: true });
  cases.add('pattern:continue');
  if (continued.statusCode !== 200) throw new Error(`the closed set expected a continued pattern run to be served, and it answered ${continued.statusCode}`);
  keep();
  const types = [['gadget'], ['phone'], ['gadget', 'phone']];
  for (const neighborTypes of types) {
    for (const direction of ['out', 'in', 'both']) {
      for (const relTypes of [undefined, ['MADE_FROM'], ['USES'], ['MADE_FROM', 'USES']]) {
        // each read is also made with a window (its statements differ from the others only by the window conditions; the instants are parameters)
        for (const window of [undefined, { days: 7 }, { from: '2026-01-01', to: '2026-01-31' }]) {
          for (const mask of [undefined, true, false]) {
            const response = await post('/v1/graph/expand', { sourceId: FUZZ_SOURCE, ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes, direction, ...(relTypes === undefined ? {} : { relTypes }), ...(mask === undefined ? {} : { mask }), ...(window === undefined ? {} : { window }), limit: 2 });
            const body = jsonOf(response.body);
            for (const neighborType of neighborTypes) for (const cursor of cursorsOf(body).slice(0, 1)) expandCursors.push({ neighborType, cursor });
            keys.push(...tokensOf(body).slice(0, 1));
            keep();
          }
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
  const instants = windows.flatMap((window) => (window === undefined ? [] : [expandWindowInstantsOf(window, new Date(rig.clock.now())), windowInstantsOf(window, new Date(rig.clock.now()))])).flatMap((pair) => [pair.windowFrom, pair.windowTo]);
  return { statements, routes, cases, patternStatements, values: ['W-1', 'GD-0', FUZZ_PATTERN_TEXT, FUZZ_PATTERN_SUPERNODE, FUZZ_PATTERN_STOPPED, 'L-1', 'H-1', holder.stableId, FUZZ_HEAVY_ANCHOR, '2026-01-01', '2026-01-31', ...instants, FUZZ_TEXT, 'ne', '+1-212-555-01', ...cursors, ...expandCursors.map((entry) => entry.cursor), ...keys.map((entry) => entry.stableId)] };
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
export interface PatternGrammarCheck {
  readonly grammar: PatternGrammar;
  readonly allowlist: SourceAllowlist;
  /** The names a statement of the pattern template may quote, when they are not the rig's own. */
  readonly names?: ReadonlySet<string>;
}

let fuzzAllowlist: SourceAllowlist | undefined;
/** The names of the fuzz source, for the grammar check of its pattern statements. */
function patternAllowlistOf(): SourceAllowlist {
  const [source] = FUZZ_MAPPING.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  fuzzAllowlist ??= allowlistFromMapping(source);
  return fuzzAllowlist;
}

export function statementProblems(rig: FuzzRig, closed: ReadonlySet<string>, requestTexts: readonly string[], pattern?: PatternGrammarCheck): StatementProblem[] {
  const names = allowedNames();
  const problems: StatementProblem[] = [];
  for (const call of rig.executor.calls) {
    if (call.templateId === 'pattern') {
      for (const reason of grammarProblems(call.cypher, pattern?.grammar ?? learnedGrammar(), pattern?.allowlist ?? patternAllowlistOf())) problems.push({ cypher: call.cypher, reason });
    } else if (!closed.has(call.cypher)) problems.push({ cypher: call.cypher, reason: 'not in the closed set' });
    const mine = call.templateId === 'pattern' && pattern?.names !== undefined ? pattern.names : names;
    for (const name of quotedNamesOf(call.cypher)) if (!mine.has(name)) problems.push({ cypher: call.cypher, reason: `quotes ${JSON.stringify(name)}` });
    for (const text of requestTexts) if (call.cypher.includes(text)) problems.push({ cypher: call.cypher, reason: `holds request text ${JSON.stringify(text)}` });
  }
  return problems;
}
