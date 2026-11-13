import { expandFilterSchema, expandRankSchema, filterShapeProblem, MAX_FILTERS } from '@neburyx/contracts';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { MAX_EVIDENCE_PROPERTIES, MAX_FACET_PROBES, MAX_REFERENCE_PROPERTIES, MAX_SEARCH_PROPERTIES } from '../mapping/model.js';
import { declarationsOf, degreePairsOf } from './templates/degree-pairs.js';
import { expandBranchesOf, expandCountStatementOf, expandStatementOf, undeclaredFilter, undeclaredRank, type ExpandDirection } from './templates/expand-statement.js';
import { aggregateStatementOf } from './templates/aggregate-statement.js';
import { linkedEntitiesCountStatementOf, linkedEntitiesRequestOf, linkedEntitiesStatementOf } from './templates/linked-entities-statement.js';
import { patternRequestOf } from './templates/pattern-request.js';
import { patternCountStatementOf, patternStatementOf } from './templates/pattern-statement.js';
import { sharedAttributeCountStatementOf, sharedAttributeRequestOf, sharedAttributeStatementOf } from './templates/shared-attribute-statement.js';
import { derivedRuleStatementOf, derivedSupportStatementOf, ruleOf } from './templates/derived-rule-statement.js';
import { CONTEXT_BRANCHES, contextBranchesOf, relatedContextStatementOf, type ContextBranch } from './templates/related-context-statement.js';
import type { GateParameter, Params, SourceAllowlist, Template } from './types.js';

/**
 * A marker in a template's Cypher, such as `@entity(kind)`, `@relationship(via)`, `@stableId(kind)` or `@searchBranches(targets)`; the name in the brackets is a parameter name.
 * `@stableId(kind)` writes the `stable_id` property of the entity type that the parameter `kind` names.
 * `@searchBranches(targets)` writes one branch for each target in the list parameter `targets`, from the template's branch text (see `Template.searchBranches`).
 * `@facetProbes(probes)` writes the whole statement of the facet probes (see `Template.facetProbes`).
 * `@degreeCounts(kind)` writes the whole statement of a degree read for the entity type the parameter `kind` names (see `Template.degreeCounts`).
 * `@edgeLoad(type)` writes the whole statement of the read of one stored edge (see `Template.edgeLoad`).
 */
const MARKER = /@(entity|relationship|stableId|searchBranches|facetProbes|degreeCounts|expandNeighbors|relatedContext|derivedRule|derivedSupport|sharedAttribute|linkedEntities|pattern|edgeLoad|aggregateRead)\(([A-Za-z][A-Za-z0-9]*)\)/g;
/**
 * The placeholders of a branch text: for a target of an entity type the label of the type and the property (`@label`, `@property`) and, in a search branch, the entity type of the target
 * (`@entityType`, written as the parameter `$branchEntityTypes[<branch position>]`); for a target of a relationship mapping row the relationship type, the labels of its two entity types and the property (`@type`, `@fromLabel`, `@toLabel`, `@property`).
 */
export const BRANCH_MARKER = /@(label|property|entityType|type|fromLabel|toLabel)(?![A-Za-z0-9])/g;
/** A name that cannot sit inside backticks: one with a backtick, a backslash or a control character, such as `a`b`. */
const UNQUOTABLE = /[`\\\u0000-\u001f\u007f]/;

export function nameProblem(name: string): string | undefined {
  if (name.trim() === '') return 'is empty or only whitespace';
  if (UNQUOTABLE.test(name)) return 'holds a backtick, a backslash or a control character';
  return undefined;
}

export function quoteName(name: string): string {
  if (nameProblem(name) !== undefined) throw new AppError('INTERNAL_ERROR');
  return `\`${name}\``;
}

/** The list parameter the gate fills with the entity type of each search branch, in branch order, from the validated targets; no request or template sets it. */
export const BRANCH_ENTITY_TYPES = 'branchEntityTypes';

export type MarkerKind = 'entity' | 'relationship' | 'stableId' | 'searchBranches' | 'facetProbes' | 'degreeCounts' | 'expandNeighbors' | 'relatedContext' | 'derivedRule' | 'derivedSupport' | 'sharedAttribute' | 'linkedEntities' | 'pattern' | 'edgeLoad' | 'aggregateRead';

export function markersOf(cypher: string): { readonly kind: MarkerKind; readonly name: string }[] {
  return [...cypher.matchAll(MARKER)].flatMap((match) => {
    const [, kind, name] = match;
    return (kind === 'entity' || kind === 'relationship' || kind === 'stableId' || kind === 'searchBranches' || kind === 'facetProbes' || kind === 'degreeCounts' || kind === 'expandNeighbors' || kind === 'relatedContext' || kind === 'derivedRule' || kind === 'derivedSupport' || kind === 'sharedAttribute' || kind === 'linkedEntities' || kind === 'pattern' || kind === 'edgeLoad' || kind === 'aggregateRead') && name !== undefined ? [{ kind, name }] : [];
  });
}

export function hasStrayMarkerCharacter(cypher: string): boolean {
  return cypher.replace(MARKER, '').includes('@');
}

function relationshipTypesOf(value: unknown, allowed: ReadonlySet<string>): string[] {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
  if (list === undefined || list.length === 0 || !list.every((entry): entry is string => typeof entry === 'string')) throw new AppError('INVALID_REQUEST');
  if (new Set(list).size !== list.length || !list.every((entry) => allowed.has(entry))) throw new AppError('INVALID_REQUEST');
  return list;
}

/** The values of the parameters the template asks the gate to fill in, from the allowlist, in a fixed order. */
function gateValuesOf(template: Template, allowlist: SourceAllowlist): [string, readonly string[]][] {
  const values: Record<GateParameter, readonly string[]> = {
    mappedLabels: [...new Set(allowlist.entityLabels.values())].sort(),
    mappedTypes: [...allowlist.relationshipTypes].sort(),
    mappedProperties: [...allowlist.properties].sort(),
  };
  return (template.gateParameters ?? []).map((name) => [name, values[name]]);
}

const targetSchema = z.strictObject({ entityType: z.string(), property: z.string(), match: z.enum(['value', 'text']) });
const evidenceTargetSchema = z.strictObject({ relationshipType: z.string(), from: z.string(), to: z.string(), property: z.string(), match: z.enum(['value', 'text']) });

/** The branch of one entity target, checked against the `search` or the `reference` properties of the mapping; `position` is the branch's place in a search statement, whose text returns the entity type. */
function entityBranchOf(target: { readonly entityType: string; readonly property: string }, kind: 'search' | 'reference', text: string, allowlist: SourceAllowlist, position?: number): string {
  const label = allowlist.entityLabels.get(target.entityType);
  if (label === undefined || (kind === 'search' ? allowlist.searchProperties : allowlist.referenceProperties).get(target.entityType)?.includes(target.property) !== true) throw new AppError('INVALID_REQUEST');
  return text.replace(BRANCH_MARKER, (_whole, placeholder: string) => {
    if (placeholder !== 'entityType') return quoteName(placeholder === 'label' ? label : target.property);
    if (position === undefined) throw new AppError('INTERNAL_ERROR');
    return `$${BRANCH_ENTITY_TYPES}[${position}]`;
  });
}

/** The branch of one evidence target, which must be an evidence property of a relationship mapping row, with the labels of that row's two entity types. */
function evidenceBranchOf(target: { readonly relationshipType: string; readonly from: string; readonly to: string; readonly property: string }, text: string, allowlist: SourceAllowlist): string {
  const row = allowlist.evidenceRows.find((candidate) => candidate.type === target.relationshipType && candidate.from === target.from && candidate.to === target.to);
  const fromLabel = allowlist.entityLabels.get(target.from);
  const toLabel = allowlist.entityLabels.get(target.to);
  if (row === undefined || fromLabel === undefined || toLabel === undefined || !row.properties.includes(target.property)) throw new AppError('INVALID_REQUEST');
  const names: Record<string, string> = { type: target.relationshipType, fromLabel, toLabel, property: target.property };
  return text.replace(BRANCH_MARKER, (_whole, placeholder: string) => quoteName(names[placeholder] ?? ''));
}

/** The branches of a template that has them: one for each target, checked against the search allowlist, each name quoted by `quoteName`, joined by `UNION`; empty for a template without branches. */
function branchesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const branches = template.searchBranches;
  if (branches === undefined) return '';
  if (branches.allowlist === 'evidence') return evidenceBranchesOf(template, params, allowlist);
  const list = z.array(targetSchema).max(MAX_SEARCH_PROPERTIES).safeParse(params[branches.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  if (list.data.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const seen = new Set<string>();
  return list.data
    .map((target, position) => {
      const key = JSON.stringify([target.entityType, target.property]);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      return entityBranchOf(target, branches.allowlist === 'search' ? 'search' : 'reference', branches[target.match], allowlist, position);
    })
    .join(' UNION ');
}

/** The entity type the last step of a pattern run arrives at, for the position a page's cursor holds; the count of a pattern run holds no position. */
function endTypeOf(template: Template, params: Params, allowlist: SourceAllowlist): [string, string][] {
  if (template.pattern === undefined || template.pattern.count === true) return [];
  const last = patternRequestOf(allowlist, params).steps.at(-1);
  return last === undefined ? [] : [['endType', last.arrivesAt]];
}

/** `$branchEntityTypes`: the entity type of each branch of an entity search, in branch order, from the targets `branchesOf` checked; none for a template without entity branches. */
function branchEntityTypesOf(template: Template, params: Params): [string, readonly string[]][] {
  const branches = template.searchBranches;
  if (branches === undefined || branches.allowlist === 'evidence') return [];
  const list = z.array(targetSchema).safeParse(params[branches.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  return [[BRANCH_ENTITY_TYPES, list.data.map((target) => target.entityType)]];
}

/** The branches of an evidence template: one for each target, which must be an evidence property of a relationship mapping row that has a `stable_id`, with the labels of that row's two entity types. */
function evidenceBranchesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const branches = template.searchBranches;
  if (branches === undefined) return '';
  const list = z.array(evidenceTargetSchema).max(MAX_SEARCH_PROPERTIES).safeParse(params[branches.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  if (list.data.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const seen = new Set<string>();
  return list.data
    .map((target) => {
      const key = JSON.stringify([target.relationshipType, target.from, target.to, target.property]);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      return evidenceBranchOf(target, branches[target.match], allowlist);
    })
    .join(' UNION ');
}

const facetTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.enum(['search', 'reference']), entityType: z.string(), property: z.string(), match: z.enum(['value', 'text']) }),
  z.strictObject({ kind: z.literal('evidence'), relationshipType: z.string(), from: z.string(), to: z.string(), property: z.string(), match: z.enum(['value', 'text']) }),
]);

/**
 * The statement of the facet probes of a template that has them: for each probe `i` a `CALL { CALL { <its branches joined by UNION> } WITH n LIMIT $countCap + 1 RETURN count(*) AS c<i> }` (`r` for a probe of
 * evidence), then one `RETURN` of every `c<i>`. A probe holds targets of one kind, each checked against the allowlist of its kind and quoted by `quoteName`; the number `i` is the position of the probe in
 * the list, written by this function and never taken from the request.
 */
function facetProbesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.facetProbes;
  if (spec === undefined) return '';
  const list = z.array(z.strictObject({ targets: z.array(facetTargetSchema).max(MAX_SEARCH_PROPERTIES + MAX_REFERENCE_PROPERTIES + MAX_EVIDENCE_PROPERTIES) })).max(MAX_FACET_PROBES).safeParse(params[spec.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  if (list.data.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const calls = list.data.map((probe, index) => {
    const first = probe.targets[0];
    if (first === undefined) throw new AppError('INVALID_REQUEST');
    const evidence = first.kind === 'evidence';
    const seen = new Set<string>();
    const branches = probe.targets.map((target) => {
      if ((target.kind === 'evidence') !== evidence) throw new AppError('INVALID_REQUEST');
      const key = JSON.stringify(target);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      if (target.kind === 'evidence') return evidenceBranchOf(target, spec.evidence[target.match], allowlist);
      return entityBranchOf(target, target.kind, spec.node[target.match], allowlist);
    });
    return `CALL { CALL { ${branches.join(' UNION ')} } WITH ${evidence ? 'r' : 'n'} LIMIT $countCap + 1 RETURN count(*) AS c${index} }`;
  });
  return `${calls.join('\n')}\nRETURN ${list.data.map((_probe, index) => `c${index}`).join(', ')}`;
}

const ANCHOR = 'MATCH (n:@label) WHERE n.@stableId IN [$stableId, $stableInteger] WITH n ORDER BY elementId(n) LIMIT $limit + 1';

/**
 * The statement of a degree read: the anchor lookup of the entity read (the node found by its label and `stable_id` property, the first by element ID, one row more than asked for to learn whether another
 * node has the ID), then one count for each mapped pair of the entity type, in `degreePairsOf` order. A bounded count expands at most `$countCap + 1` relationships of the pair; a cheap count is the
 * server's `COUNT { }` of the pair with no predicate. Every name is quoted by `quoteName` from the allowlist, and the position of a count, never the request, names its column.
 */
function degreeCountsOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.degreeCounts;
  if (spec === undefined) return '';
  const entityType = params[spec.param];
  const label = typeof entityType === 'string' ? allowlist.entityLabels.get(entityType) : undefined;
  const stableId = typeof entityType === 'string' ? allowlist.stableIds.get(entityType) : undefined;
  if (typeof entityType !== 'string' || label === undefined || stableId === undefined) throw new AppError('INVALID_REQUEST');
  const pairs = degreePairsOf(allowlist.relationshipRows, entityType);
  if (pairs.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const anchor = ANCHOR.replace('@label', quoteName(label)).replace('@stableId', quoteName(stableId));
  const patterns = pairs.map((pair) => (pair.direction === 'out' ? `(n)-[:${quoteName(pair.relationshipType)}]->()` : `(n)<-[:${quoteName(pair.relationshipType)}]-()`));
  if (spec.form === 'cheap') return `${anchor}\nRETURN ${patterns.map((pattern, index) => `COUNT { ${pattern} } AS c${index}`).join(', ')}`;
  const calls = patterns.map((pattern, index) => `CALL { WITH n MATCH ${pattern} WITH 1 AS hit LIMIT $countCap + 1 RETURN count(*) AS c${index} }`);
  const declared = declarationsOf(pairs, allowlist.degreeProperties?.get(entityType));
  const properties = declared.flatMap((declaration, index) => (declaration === undefined ? [] : [`n.${quoteName(declaration.property)} AS p${index}`, ...(declaration.observedAt === undefined ? [] : [`n.${quoteName(declaration.observedAt)} AS t${index}`])]));
  return `${anchor}\n${calls.join('\n')}\nRETURN ${[...patterns.map((_pattern, index) => `c${index}`), ...properties].join(', ')}`;
}

/**
 * The statement of an expansion read: the rows of the mapping that join the anchor's entity type to the neighbor type, for the asked direction and relationship types (checked against the
 * allowlist), written as `expandStatementOf` says. A request that names no joining row has nothing to read.
 */
function expandNeighborsOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.expandNeighbors;
  if (spec === undefined) return '';
  const anchor = params[spec.anchorParam];
  const neighbor = params[spec.neighborParam];
  const direction = params[spec.directionParam];
  const relTypes = params[spec.relTypesParam];
  if (typeof anchor !== 'string' || typeof neighbor !== 'string' || !allowlist.entityLabels.has(anchor) || !allowlist.entityLabels.has(neighbor)) throw new AppError('INVALID_REQUEST');
  if (direction !== 'out' && direction !== 'in' && direction !== 'both') throw new AppError('INVALID_REQUEST');
  const types = relTypes === undefined ? undefined : relationshipTypesOf(relTypes, allowlist.relationshipTypes);
  const branches = expandBranchesOf(allowlist, anchor, neighbor, types, direction satisfies ExpandDirection);
  if (branches.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const filters = params['filters'];
  const rank = params['rank'];
  const windowed = params['windowFrom'] !== undefined;
  if (spec.form === 'count' && ((filters === undefined && !windowed) || rank !== undefined)) throw new AppError('INVALID_REQUEST');
  if (filters === undefined && rank === undefined && !windowed) return expandStatementOf(allowlist, anchor, neighbor, branches);
  const parsedFilters = filters === undefined ? undefined : z.array(expandFilterSchema).max(MAX_FILTERS).safeParse(filters);
  const parsedRank = rank === undefined ? undefined : expandRankSchema.safeParse(rank);
  if (parsedFilters?.success === false || parsedRank?.success === false) throw new AppError('INVALID_REQUEST');
  const given = parsedFilters?.data ?? [];
  if (given.some((filter) => filterShapeProblem(filter) !== undefined) || undeclaredFilter(allowlist, neighbor, branches, given) !== undefined) throw new AppError('INVALID_REQUEST');
  if (parsedRank?.data !== undefined && undeclaredRank(allowlist, neighbor, branches, parsedRank.data)) throw new AppError('INVALID_REQUEST');
  if (spec.form === 'count') return expandCountStatementOf(allowlist, anchor, neighbor, branches, given, windowed);
  return expandStatementOf(allowlist, anchor, neighbor, branches, given, parsedRank?.data, windowed);
}

const contextRefSchema = z.looseObject({ entityType: z.string() });

/**
 * The statement of a relationship context read and the branches its parameter holds: the lists of hits and of exact matches, each at most the limit, name entity types of the mapping, and the statement
 * is written from the mapping rows that join a type of one list to a type of the other. A request with no row that joins them has nothing to read.
 */
function relatedContextOf(template: Template, params: Params, allowlist: SourceAllowlist, limit: number): { readonly cypher: string; readonly branches: readonly ContextBranch[] } {
  const spec = template.relatedContext;
  if (spec === undefined) return { cypher: '', branches: [] };
  const hits = z.array(contextRefSchema).max(limit).safeParse(params[spec.hitsParam]);
  const exact = z.array(contextRefSchema).max(limit).safeParse(params[spec.exactParam]);
  if (!hits.success || !exact.success) throw new AppError('INVALID_REQUEST');
  const hitTypes = new Set(hits.data.map((entry) => entry.entityType));
  const exactTypes = new Set(exact.data.map((entry) => entry.entityType));
  if ([...hitTypes, ...exactTypes].some((type) => !allowlist.entityLabels.has(type))) throw new AppError('INVALID_REQUEST');
  const branches = hits.data.length === 0 || exact.data.length === 0 ? [] : contextBranchesOf(allowlist, hitTypes, exactTypes);
  if (branches.length === 0) {
    if (template.readsNothing?.(params, allowlist) === true) return { cypher: '', branches: [] };
    throw new AppError('INVALID_REQUEST');
  }
  return { cypher: relatedContextStatementOf(allowlist, branches), branches };
}

/** The statement of a rule run: the rule the request names, checked against the mapping's rules and against the entity type, written as `derivedRuleStatementOf` says. */
function derivedRuleOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.derivedRule;
  if (spec === undefined) return '';
  return derivedRuleStatementOf(allowlist, ruleOf(allowlist, params[spec.ruleParam], params[spec.entityTypeParam]));
}

/** The statement of a linked-entities run: the entity types and the relationship types the request names, checked against the mapping's rows, written as `linkedEntitiesStatementOf` says. */
function linkedEntitiesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  if (template.linkedEntities === undefined) return '';
  const request = linkedEntitiesRequestOf(allowlist, params);
  return template.linkedEntities.count === true ? linkedEntitiesCountStatementOf(allowlist, request) : linkedEntitiesStatementOf(allowlist, request);
}

/** The statement of a pattern run: the entity types, relationship types and conditions the request names, checked against the mapping's rows, written as `patternStatementOf` says. */
function patternOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  if (template.pattern === undefined) return '';
  const request = patternRequestOf(allowlist, params);
  return template.pattern.count === true ? patternCountStatementOf(allowlist, request) : patternStatementOf(allowlist, request);
}

/** The statement of a shared-attribute run: the entity types and the relationship type the request names, checked against the mapping's rows, written as `sharedAttributeStatementOf` says. */
function sharedAttributeOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  if (template.sharedAttribute === undefined) return '';
  const request = sharedAttributeRequestOf(allowlist, params);
  return template.sharedAttribute.count === true ? sharedAttributeCountStatementOf(allowlist, request) : sharedAttributeStatementOf(allowlist, request);
}

/** The statement of the supports of a derived relationship: the rule the request names, checked against the mapping's rules and against the type of the first end, written as `derivedSupportStatementOf` says. */
function derivedSupportOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.derivedSupport;
  if (spec === undefined) return '';
  const ends = z.array(z.looseObject({ entityType: z.string() })).length(2).safeParse(params[spec.endsParam]);
  if (!ends.success) throw new AppError('INVALID_REQUEST');
  const rule = ruleOf(allowlist, params[spec.ruleParam], ends.data[0]?.entityType);
  if (ends.data[1]?.entityType !== rule.to) throw new AppError('INVALID_REQUEST');
  return derivedSupportStatementOf(allowlist, rule);
}

/**
 * The statement of the read of one stored edge: the mapping row that joins the two entity types by the edge type and holds a `stable_id` gives the quoted names, the edge is matched by that
 * property as the text and as the integer it may be, and two rows are read: the one the template asks for and one more, which only says that another edge has the ID. A request that names no such row is refused before any read.
 */
function edgeLoadOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.edgeLoad;
  if (spec === undefined) return '';
  const [type, from, to] = [params[spec.typeParam], params[spec.fromParam], params[spec.toParam]];
  const row = allowlist.relationshipRows.find((candidate) => candidate.type === type && candidate.from === from && candidate.to === to);
  const fromLabel = typeof from === 'string' ? allowlist.entityLabels.get(from) : undefined;
  const toLabel = typeof to === 'string' ? allowlist.entityLabels.get(to) : undefined;
  if (row?.stableId === undefined || fromLabel === undefined || toLabel === undefined) throw new AppError('INVALID_REQUEST');
  const pattern = `(a:${quoteName(fromLabel)})-[r:${quoteName(row.type)}]->(b:${quoteName(toLabel)})`;
  if (spec.listParam !== undefined) {
    // one statement for a list of IDs: each ID reads at most two relationships (the second only says that another has the ID) and answers its first by element ID; the hint makes the planner seek the ID in the index whatever the statistics say, and never scan the index or start from an end
    return `UNWIND range(0, size($${spec.listParam}) - 1) AS i CALL { WITH i MATCH ${pattern} USING INDEX SEEK r:${quoteName(row.type)}(${quoteName(row.stableId)}) WHERE r.${quoteName(row.stableId)} IN [$${spec.listParam}[i].stableId, $${spec.listParam}[i].stableInteger] RETURN r, a, b ORDER BY elementId(r) LIMIT 2 } WITH i, collect([r, a, b]) AS found RETURN i, found[0][0] AS r, found[0][1] AS a, found[0][2] AS b, size(found) > 1 AS dup ORDER BY i LIMIT $limit + 1`;
  }
  return `MATCH ${pattern} WHERE r.${quoteName(row.stableId)} IN [$stableId, $stableInteger] RETURN r, a, b ORDER BY elementId(r) LIMIT $limit + 1`;
}

/** The statement of one aggregate read (see `Template.aggregateRead`): the mapping row that joins the two ends' entity types by the type is looked up in the allowlist, and a request that names none is refused before any read. */
function aggregateReadOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.aggregateRead;
  if (spec === undefined) return '';
  const ends = params[spec.endsParam];
  const [from, to] = Array.isArray(ends) ? ends.map((end: unknown) => (typeof end === 'object' && end !== null && 'entityType' in end ? end.entityType : undefined)) : [];
  return aggregateStatementOf(allowlist, params[spec.typeParam], from, to, spec.form);
}

export interface Rendered {
  readonly cypher: string;
  readonly parameters: Params;
}

/** Checks the marker parameters against the allowlist and writes the quoted names into the Cypher; every other parameter stays a parameter. */
export function renderTemplate(template: Template, params: Params, allowlist: SourceAllowlist, limit: number, countCap = 0): Rendered {
  const replacements = new Map<string, string>();
  for (const name of template.entityParams) {
    const value = params[name];
    const label = typeof value === 'string' ? allowlist.entityLabels.get(value) : undefined;
    if (label === undefined) throw new AppError('INVALID_REQUEST');
    replacements.set(`entity:${name}`, label);
    const stableId = allowlist.stableIds.get(String(value));
    if (stableId !== undefined) replacements.set(`stableId:${name}`, stableId);
  }
  for (const name of template.relationshipParams) {
    replacements.set(`relationship:${name}`, relationshipTypesOf(params[name], allowlist.relationshipTypes).map((type) => quoteName(type)).join('|'));
  }
  const branches = branchesOf(template, params, allowlist);
  const probes = facetProbesOf(template, params, allowlist);
  const degrees = degreeCountsOf(template, params, allowlist);
  const expansion = expandNeighborsOf(template, params, allowlist);
  const context = relatedContextOf(template, params, allowlist, limit);
  const derivation = derivedRuleOf(template, params, allowlist);
  const support = derivedSupportOf(template, params, allowlist);
  const shared = sharedAttributeOf(template, params, allowlist);
  const linked = linkedEntitiesOf(template, params, allowlist);
  const walked = patternOf(template, params, allowlist);
  const edge = edgeLoadOf(template, params, allowlist);
  const aggregate = aggregateReadOf(template, params, allowlist);
  const cypher = template.cypher.replace(MARKER, (_whole, kind: string, name: string) => {
    if (kind === 'searchBranches') return branches;
    if (kind === 'facetProbes') return probes;
    if (kind === 'degreeCounts') return degrees;
    if (kind === 'expandNeighbors') return expansion;
    if (kind === 'relatedContext') return context.cypher;
    if (kind === 'edgeLoad') return edge;
    if (kind === 'aggregateRead') return aggregate;
    if (kind === 'derivedRule') return derivation;
    if (kind === 'derivedSupport') return support;
    if (kind === 'sharedAttribute') return shared;
    if (kind === 'linkedEntities') return linked;
    if (kind === 'pattern') return walked;
    const replacement = replacements.get(`${kind}:${name}`) ?? '';
    return kind === 'relationship' ? replacement : quoteName(replacement);
  });
  const markerNames = new Set([...template.entityParams, ...template.relationshipParams, ...(template.searchBranches === undefined ? [] : [template.searchBranches.param]), ...(template.facetProbes === undefined ? [] : [template.facetProbes.param]), ...(template.degreeCounts === undefined ? [] : [template.degreeCounts.param]), ...(template.expandNeighbors === undefined ? [] : [template.expandNeighbors.relTypesParam, template.expandNeighbors.directionParam]), ...(template.derivedRule === undefined ? [] : [template.derivedRule.ruleParam]), ...(template.derivedSupport === undefined ? [] : [template.derivedSupport.ruleParam]), ...(template.edgeLoad === undefined ? [] : [template.edgeLoad.typeParam, template.edgeLoad.fromParam, template.edgeLoad.toParam]), ...(template.aggregateRead === undefined ? [] : [template.aggregateRead.typeParam])]);
  const kept = Object.entries(params).filter(([key]) => !markerNames.has(key));
  const cap: [string, unknown][] = template.degreeCounts?.form === 'bounded' || template.facetProbes !== undefined || template.sharedAttribute !== undefined || template.linkedEntities !== undefined || template.pattern !== undefined ? [['countCap', countCap]] : [];
  return { cypher, parameters: Object.fromEntries([...kept, ['limit', limit], ...cap, ...gateValuesOf(template, allowlist), ...endTypeOf(template, params, allowlist), ...branchEntityTypesOf(template, params), ...(template.relatedContext === undefined ? [] : [[CONTEXT_BRANCHES, context.branches.map((branch) => ({ hitType: branch.hitType, exactType: branch.exactType, type: branch.type, direction: branch.direction }))] as [string, unknown]])]) };
}
