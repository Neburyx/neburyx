import { z } from 'zod';
import { MAX_HOPS_CEILING } from '../mapping/budgets.js';
import { CONTEXT_BRANCHES } from './templates/related-context-statement.js';
import { BRANCH_ENTITY_TYPES, BRANCH_MARKER, hasStrayMarkerCharacter, markersOf } from './render.js';
import { GATE_PARAMETERS, type Template, type TemplateCatalog } from './types.js';

export type TemplateDefinition = Omit<Template, 'integerParameters'>;

export class CatalogError extends Error {
  constructor(templateId: string, problem: string) {
    super(`the template ${templateId} ${problem}`);
    this.name = 'CatalogError';
  }
}

/** Parameters the gate fills in, which a template may not declare: the page limit, the verified cursor position and the entity type of each search branch. */
const RESERVED = ['limit', 'cursor', BRANCH_ENTITY_TYPES, CONTEXT_BRANCHES] as const;
const BRANCH_ENTITY_TYPES_REFERENCE = new RegExp(`\\$${BRANCH_ENTITY_TYPES}(?![\\w])`);

const article = (kind: string): string => (kind === 'entity' ? 'an' : 'a');
/** The server-side page bound a paged template must carry, as in `LIMIT $limit + 1`. */
const PAGED_LIMIT = /LIMIT\s+\$limit\s*\+\s*1(?![\w$])/;
/** The bound of a facet probe, as in `LIMIT $countCap + 1`: the source's count cap, which the gate fills in. */
const COUNT_CAP_LIMIT = /LIMIT\s+\$countCap\s*\+\s*1(?![\w$])/;
/** The keyset of a search page, for the variable `n` or `r`: the rows after the cursor, sorted by element ID and cut at one more than the page, as in `elementId(n) > $cursor.after ... ORDER BY elementId(n) LIMIT $limit + 1`. */
const keysetFilter = (variable: string): RegExp => new RegExp(`\\$cursor\\s+IS\\s+NULL\\s+OR\\s+elementId\\(${variable}\\)\\s*>\\s*\\$cursor\\.after(?![\\w$])`);
const keysetOrder = (variable: string): RegExp => new RegExp(`ORDER\\s+BY\\s+elementId\\(${variable}\\)\\s+LIMIT\\s+\\$limit\\s*\\+\\s*1(?![\\w$])`);
/** What a capped search read may not hold: a cursor, or a sort that would read every match before the cut. */
const CURSOR_OR_SORT = /\$cursor(?![\w$])|ORDER\s+BY/;
/** The sort a search template's cursor binds. */
const SEARCH_SORT = 'elementId';

interface Shape {
  readonly properties: ReadonlyMap<string, string | undefined>;
}

function shapeOf(definition: TemplateDefinition): Shape {
  let json: z.core.JSONSchema.BaseSchema;
  try {
    json = z.toJSONSchema(definition.paramsSchema, { io: 'input', unrepresentable: 'any' });
  } catch {
    throw new CatalogError(definition.id, 'has a parameter schema that cannot be inspected');
  }
  if (json.type !== 'object' || json.additionalProperties !== false) throw new CatalogError(definition.id, 'has a parameter schema that is not a strict object');
  const properties = new Map<string, string | undefined>();
  for (const [name, property] of Object.entries(json.properties ?? {})) {
    const type = typeof property === 'object' && property !== null && 'type' in property && typeof property.type === 'string' ? property.type : undefined;
    properties.set(name, type);
  }
  return { properties };
}

/** A gate-filled parameter is declared exactly when the Cypher uses it, and a caller cannot also give it. */
function checkGateParameters(definition: TemplateDefinition, shape: Shape): void {
  const declared = definition.gateParameters ?? [];
  for (const name of GATE_PARAMETERS) {
    const used = new RegExp(`\\$${name}(?![\\w])`).test(definition.cypher);
    if (declared.includes(name) && !used) throw new CatalogError(definition.id, `declares the gate-filled parameter ${name} its Cypher never uses`);
    if (used && !declared.includes(name)) throw new CatalogError(definition.id, `uses the gate-filled parameter ${name} without declaring it`);
    if (declared.includes(name) && shape.properties.has(name)) throw new CatalogError(definition.id, `has the gate-filled parameter ${name} in its parameter schema`);
  }
}

function checkMarkers(definition: TemplateDefinition, shape: Shape): void {
  if (hasStrayMarkerCharacter(definition.cypher)) throw new CatalogError(definition.id, 'has Cypher with an @ that is not a marker');
  const degree = markersOf(definition.cypher).filter((marker) => marker.kind === 'degreeCounts');
  // a degree statement reads the entity type's label and stable ID property, so its parameter counts as used by an entity marker and a stable id marker
  const used = [
    ...markersOf(definition.cypher).filter((marker) => marker.kind !== 'searchBranches' && marker.kind !== 'facetProbes' && marker.kind !== 'degreeCounts' && marker.kind !== 'expandNeighbors' && marker.kind !== 'relatedContext' && marker.kind !== 'edgeLoad' && marker.kind !== 'derivedRule' && marker.kind !== 'derivedSupport' && marker.kind !== 'sharedAttribute' && marker.kind !== 'aggregateRead'),
    ...markersOf(definition.cypher).filter((marker) => marker.kind === 'derivedRule').flatMap(() => (definition.derivedRule === undefined ? [] : [{ kind: 'entity' as const, name: definition.derivedRule.entityTypeParam }, { kind: 'stableId' as const, name: definition.derivedRule.entityTypeParam }])),
    ...markersOf(definition.cypher)
      .filter((marker) => marker.kind === 'sharedAttribute')
      .flatMap(() => (definition.sharedAttribute === undefined ? [] : [{ kind: 'entity' as const, name: definition.sharedAttribute.entityTypeParam }, { kind: 'stableId' as const, name: definition.sharedAttribute.entityTypeParam }, { kind: 'entity' as const, name: definition.sharedAttribute.attributeTypeParam }, { kind: 'relationship' as const, name: definition.sharedAttribute.viaParam }])),
    ...markersOf(definition.cypher).filter((marker) => marker.kind === 'expandNeighbors').flatMap((marker) => [{ kind: 'entity' as const, name: marker.name }, { kind: 'stableId' as const, name: marker.name }]),
    ...degree.flatMap((marker) => [{ kind: 'entity' as const, name: marker.name }, { kind: 'stableId' as const, name: marker.name }]),
  ];
  for (const marker of used) {
    if (marker.kind === 'stableId' && !definition.entityParams.includes(marker.name)) throw new CatalogError(definition.id, 'has a stable id marker that no declared entity parameter backs');
  }
  const declared = [...definition.entityParams.map((name) => ({ kind: 'entity', name })), ...definition.relationshipParams.map((name) => ({ kind: 'relationship', name }))];
  for (const marker of used) {
    if (marker.kind === 'stableId') continue;
    if (!declared.some((entry) => entry.kind === marker.kind && entry.name === marker.name)) throw new CatalogError(definition.id, `has ${article(marker.kind)} ${marker.kind} marker it does not declare`);
  }
  for (const entry of declared) {
    if (!used.some((marker) => marker.kind === entry.kind && marker.name === entry.name)) throw new CatalogError(definition.id, `declares ${article(entry.kind)} ${entry.kind} marker its Cypher never uses`);
    if (!shape.properties.has(entry.name)) throw new CatalogError(definition.id, `declares a marker parameter its schema does not have`);
  }
}

/**
 * The search template's own declaration: it declares its search branches exactly when its Cypher uses the one `@searchBranches` marker for the list parameter its schema has; each branch text holds only the
 * placeholders of its targets and its own `LIMIT $limit + 1`; the combined result is cut by an enclosing `LIMIT $limit + 1`; `usedProperties` names every target, so a masked request is checked; `indexNeeds`
 * names the index of every target, so the gate can refuse a read whose index is gone; and the allowlist the targets are checked against is `search`, `reference` or `evidence`.
 */
function checkSearchBranches(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'searchBranches');
  const branches = definition.searchBranches;
  if (branches === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the search branch marker without declaring search branches');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== branches.param) throw new CatalogError(definition.id, 'declares search branches and does not use its branch marker exactly once');
  if (shape.properties.get(branches.param) !== 'array') throw new CatalogError(definition.id, 'declares search branches for a parameter its schema does not have as a list');
  const required = branches.allowlist === 'evidence' ? EVIDENCE_PLACEHOLDERS : SEARCH_ENTITY_PLACEHOLDERS;
  for (const text of [branches.value, branches.text]) {
    const placeholders = [...text.matchAll(BRANCH_MARKER)].map((match) => match[1]);
    if (!required.every((name) => placeholders.includes(name)) || !placeholders.every((name) => name !== undefined && required.includes(name)) || text.replace(BRANCH_MARKER, '').includes('@')) {
      throw new CatalogError(definition.id, `has a branch text that does not hold exactly the placeholders of its targets (${required.map((name) => `@${name}`).join(', ')})`);
    }
    if (!PAGED_LIMIT.test(text)) throw new CatalogError(definition.id, 'has a branch text with no LIMIT $limit + 1 of its own');
  }
  if (!PAGED_LIMIT.test(definition.cypher)) throw new CatalogError(definition.id, 'has search branches and its Cypher has no enclosing LIMIT $limit + 1');
  checkSearchCut(definition, branches);
  if (definition.usedProperties === undefined) throw new CatalogError(definition.id, 'has search branches and does not name the properties it uses');
  if (definition.indexNeeds === undefined) throw new CatalogError(definition.id, 'has search branches and does not name the indexes it needs');
  if (branches.allowlist !== 'search' && branches.allowlist !== 'reference' && branches.allowlist !== 'evidence') throw new CatalogError(definition.id, 'has search branches and does not say which allowlist its targets are checked against');
}

/**
 * A search template pages by keyset on the element ID of the variable it returns first (`r` for evidence, `n` otherwise): it is paged, binds the sort `elementId`, says where the next page starts,
 * and each branch text filters on the cursor and sorts by element ID before its limit, as the enclosing statement sorts before its own. A branch that is not sorted would page a different order than the union.
 * A search template that is not paged is a capped read instead: its cut means a lower bound, and neither a branch nor the statement reads a cursor or sorts, so the source stops at the limit.
 */
function checkSearchCut(definition: TemplateDefinition, branches: NonNullable<TemplateDefinition['searchBranches']>): void {
  const variable = branches.allowlist === 'evidence' ? 'r' : 'n';
  if (!definition.paged) {
    if (definition.cutMeans !== 'lowerBound') throw new CatalogError(definition.id, "has search branches and is neither paged by element ID nor declared cutMeans: 'lowerBound'");
    if ([branches.value, branches.text, definition.cypher].some((text) => CURSOR_OR_SORT.test(text))) throw new CatalogError(definition.id, 'has search branches, is not paged and reads a cursor or sorts before its limit');
    return;
  }
  if (definition.sort !== SEARCH_SORT || definition.nextPosition === undefined) throw new CatalogError(definition.id, 'has search branches and is not paged by element ID');
  for (const text of [branches.value, branches.text]) {
    if (!keysetFilter(variable).test(text) || !keysetOrder(variable).test(text)) throw new CatalogError(definition.id, `has a branch text that does not read the page after the cursor in ORDER BY elementId(${variable}) LIMIT $limit + 1`);
  }
  if (!keysetOrder(variable).test(definition.cypher)) throw new CatalogError(definition.id, `has search branches and its Cypher is not cut in ORDER BY elementId(${variable}) LIMIT $limit + 1`);
}

/**
 * The facet template's own declaration: it declares its facet probes exactly when its Cypher is the one `@facetProbes` marker for the list parameter its schema has, and nothing else; each of its four branch
 * texts holds exactly the placeholders of its target kind and a `LIMIT $countCap + 1` of its own, and returns the one variable the probe counts (`n` for an entity target, `r` for an evidence target);
 * it names the properties it uses and the indexes it needs, so a masked request is checked and the gate can refuse a read whose index is gone; and it has no `countCap` of its own (the gate fills it).
 */
function checkFacetProbes(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'facetProbes');
  const probes = definition.facetProbes;
  if (probes === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the facet probe marker without declaring facet probes');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== probes.param || definition.cypher !== `@facetProbes(${probes.param})`) throw new CatalogError(definition.id, 'declares facet probes and its Cypher is not exactly its one facet probe marker');
  if (definition.searchBranches !== undefined) throw new CatalogError(definition.id, 'declares facet probes and search branches together');
  if (shape.properties.get(probes.param) !== 'array') throw new CatalogError(definition.id, 'declares facet probes for a parameter its schema does not have as a list');
  const kinds: readonly { readonly texts: readonly string[]; readonly required: readonly string[]; readonly returns: string }[] = [
    { texts: [probes.node.value, probes.node.text], required: ENTITY_PLACEHOLDERS, returns: 'RETURN n LIMIT' },
    { texts: [probes.evidence.value, probes.evidence.text], required: EVIDENCE_PLACEHOLDERS, returns: 'RETURN r LIMIT' },
  ];
  for (const kind of kinds) {
    for (const text of kind.texts) {
      const placeholders = [...text.matchAll(BRANCH_MARKER)].map((match) => match[1]);
      if (!kind.required.every((name) => placeholders.includes(name)) || !placeholders.every((name) => name !== undefined && kind.required.includes(name)) || text.replace(BRANCH_MARKER, '').includes('@')) {
        throw new CatalogError(definition.id, `has a probe branch text that does not hold exactly the placeholders of its targets (${kind.required.map((name) => `@${name}`).join(', ')})`);
      }
      if (!COUNT_CAP_LIMIT.test(text)) throw new CatalogError(definition.id, 'has a probe branch text with no LIMIT $countCap + 1 of its own');
      if (!text.includes(kind.returns)) throw new CatalogError(definition.id, 'has a probe branch text that does not return the one variable the probe counts');
    }
  }
  if (definition.usedProperties === undefined) throw new CatalogError(definition.id, 'has facet probes and does not name the properties it uses');
  if (definition.indexNeeds === undefined) throw new CatalogError(definition.id, 'has facet probes and does not name the indexes it needs');
  if (shape.properties.has('countCap')) throw new CatalogError(definition.id, 'has the gate-filled parameter countCap in its parameter schema');
}

const ENTITY_PLACEHOLDERS: readonly string[] = ['label', 'property'];
/** A search branch of an entity target also returns the target's entity type, so the normalizer resolves a node whose labels match two types as the type that matched it. */
const SEARCH_ENTITY_PLACEHOLDERS: readonly string[] = [...ENTITY_PLACEHOLDERS, 'entityType'];
const EVIDENCE_PLACEHOLDERS: readonly string[] = ['type', 'fromLabel', 'toLabel', 'property'];

const PROFILE_PREFIX = 'PROFILE ';

/** A profiled template starts with `PROFILE ` and the flag says so, and only a system template profiles. */
function checkProfile(definition: TemplateDefinition): void {
  const starts = definition.cypher.startsWith(PROFILE_PREFIX);
  if (definition.profile === true && !starts) throw new CatalogError(definition.id, 'is profiled and its Cypher does not start with PROFILE');
  if (definition.profile !== true && starts) throw new CatalogError(definition.id, 'has Cypher that starts with PROFILE and is not declared profiled');
  if (definition.profile === true && definition.scope !== 'system') throw new CatalogError(definition.id, 'is profiled and not a system template');
}

/**
 * The degree template's own declaration: it declares its degree counts exactly when its Cypher is the one `@degreeCounts(<param>)` marker for an entity parameter its schema has, and nothing else; it
 * is not paged and not profiled, it names the stable-ID index it needs, and a bounded one has no `$countCap` of its own in its schema (the gate fills it from the budgets).
 */
function checkDegreeCounts(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'degreeCounts');
  const spec = definition.degreeCounts;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the degree counts marker without declaring degree counts');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.param || definition.cypher !== `@degreeCounts(${spec.param})`) throw new CatalogError(definition.id, 'declares degree counts and its Cypher is not exactly its one degree counts marker');
  if (!definition.entityParams.includes(spec.param) || shape.properties.get(spec.param) !== 'string') throw new CatalogError(definition.id, 'declares degree counts for a parameter that is not a declared entity parameter its schema has as text');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.paged || definition.profile === true) throw new CatalogError(definition.id, 'declares degree counts and is also paged, profiled or a search or facet template');
  if (definition.indexNeeds === undefined) throw new CatalogError(definition.id, 'has degree counts and does not name the index it needs');
  if (definition.readsNothing === undefined) throw new CatalogError(definition.id, 'has degree counts and does not say when it reads nothing');
  if (shape.properties.has('countCap')) throw new CatalogError(definition.id, 'has the gate-filled parameter countCap in its parameter schema');
}

/**
 * The expansion template's own declaration: its Cypher is exactly the one `@expandNeighbors(<anchor parameter>)` marker, it is paged, it names the stable-ID index it needs and says when it reads nothing,
 * its schema has the four parameters it names (and none of them is gate-filled), and it declares the properties its order uses.
 */
function checkExpandNeighbors(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'expandNeighbors');
  const spec = definition.expandNeighbors;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the expand neighbors marker without declaring an expansion');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.anchorParam || definition.cypher !== `@expandNeighbors(${spec.anchorParam})`) throw new CatalogError(definition.id, 'declares an expansion and its Cypher is not exactly its one expand neighbors marker');
  if (!definition.entityParams.includes(spec.anchorParam) || ![spec.anchorParam, spec.neighborParam, spec.directionParam].every((name) => shape.properties.get(name) === 'string') || !shape.properties.has(spec.relTypesParam)) throw new CatalogError(definition.id, 'declares an expansion for parameters its schema does not have');
  const counting = spec.form === 'count';
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.paged === counting || definition.profile === true || (counting && definition.rows !== 'one')) {
    throw new CatalogError(definition.id, counting ? "declares an expansion count and is also another kind of template, paged, profiled or not declared rows: 'one'" : 'declares an expansion and is also another kind of template, not paged, or profiled');
  }
  if (definition.indexNeeds === undefined || definition.readsNothing === undefined || definition.usedProperties === undefined || (!counting && definition.nextPosition === undefined)) throw new CatalogError(definition.id, 'declares an expansion and does not name its indexes, its empty case, its properties and its next position');
}

/**
 * The relationship context template's own declaration: its Cypher is exactly the one `@relatedContext(<hits parameter>)` marker, its schema has both list parameters, it is not paged, it is bounded by its
 * input (`rows: 'bounded'`), it names the stable-ID indexes it needs, says when it reads nothing and lists its reference lists, and its statement is the only one of its kind.
 */
function checkRelatedContext(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'relatedContext');
  const spec = definition.relatedContext;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the related context marker without declaring a related context');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.hitsParam || definition.cypher !== `@relatedContext(${spec.hitsParam})`) throw new CatalogError(definition.id, 'declares a related context and its Cypher is not exactly its one related context marker');
  if (shape.properties.get(spec.hitsParam) !== 'array' || shape.properties.get(spec.exactParam) !== 'array') throw new CatalogError(definition.id, 'declares a related context for parameters its schema does not have as lists');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.paged || definition.profile === true || definition.rows !== 'bounded') {
    throw new CatalogError(definition.id, "declares a related context and is also another kind of template, paged, profiled or not declared rows: 'bounded'");
  }
  if (definition.indexNeeds === undefined || definition.readsNothing === undefined) throw new CatalogError(definition.id, 'declares a related context and does not name its indexes and its empty case');
  if (![spec.hitsParam, spec.exactParam].every((name) => definition.referenceLists?.includes(name) === true)) throw new CatalogError(definition.id, 'declares a related context and does not list its two parameters as reference lists');
  if (definition.referenceParams !== undefined) throw new CatalogError(definition.id, 'declares reference lists and reference parameters, of which the gate reads back one kind only');
}

/**
 * The rule run template's own declaration: its Cypher is exactly the one `@derivedRule(<rule parameter>)` marker, its schema has the rule ID and the entity type as text, it is not paged and not
 * profiled, its cut means a lower bound, it names the stable-ID index it needs and the properties it uses, and the gate fills `limit` for it (the schema has no limit of its own).
 */
function checkDerivedRule(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'derivedRule');
  const spec = definition.derivedRule;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the derived rule marker without declaring a rule run');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.ruleParam || definition.cypher !== `@derivedRule(${spec.ruleParam})`) throw new CatalogError(definition.id, 'declares a rule run and its Cypher is not exactly its one derived rule marker');
  if (shape.properties.get(spec.ruleParam) !== 'string' || shape.properties.get(spec.entityTypeParam) !== 'string' || !definition.entityParams.includes(spec.entityTypeParam)) throw new CatalogError(definition.id, 'declares a rule run for parameters its schema does not have as text or its entity parameters do not declare');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.relatedContext !== undefined || definition.paged || definition.profile === true || definition.cutMeans !== 'lowerBound') {
    throw new CatalogError(definition.id, "declares a rule run and is also another kind of template, paged, profiled or not declared cutMeans: 'lowerBound'");
  }
  if (definition.indexNeeds === undefined || definition.usedProperties === undefined) throw new CatalogError(definition.id, 'declares a rule run and does not name its indexes and the properties it uses');
}

/**
 * The shared-attribute template's own declaration: its Cypher is exactly the one `@sharedAttribute(<attribute type parameter>)` marker, its schema has the three names (the anchor's entity type, the attribute's entity type and the
 * relationship type) as text, declared as entity and relationship parameters, it reads the anchor by its reference, it is not paged and not profiled, its cut means a lower bound, it names the stable-ID index it needs and the
 * properties it uses, and the gate fills `limit` and `countCap` for it (the schema has neither).
 */
function checkSharedAttribute(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'sharedAttribute');
  const spec = definition.sharedAttribute;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the shared attribute marker without declaring a shared attribute read');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.attributeTypeParam || definition.cypher !== `@sharedAttribute(${spec.attributeTypeParam})`) throw new CatalogError(definition.id, 'declares a shared attribute read and its Cypher is not exactly its one shared attribute marker');
  const names = [spec.entityTypeParam, spec.attributeTypeParam, spec.viaParam];
  if (names.some((name) => shape.properties.get(name) !== 'string') || !definition.entityParams.includes(spec.entityTypeParam) || !definition.entityParams.includes(spec.attributeTypeParam) || !definition.relationshipParams.includes(spec.viaParam)) {
    throw new CatalogError(definition.id, 'declares a shared attribute read for parameters its schema does not have as text or its entity and relationship parameters do not declare');
  }
  if (['limit', 'countCap'].some((name) => shape.properties.has(name))) throw new CatalogError(definition.id, 'declares a shared attribute read and has a limit or a count cap in its schema, which the gate fills');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.relatedContext !== undefined || definition.derivedRule !== undefined || definition.derivedSupport !== undefined || definition.paged || definition.profile === true || definition.cutMeans !== 'lowerBound') {
    throw new CatalogError(definition.id, "declares a shared attribute read and is also another kind of template, paged, profiled or not declared cutMeans: 'lowerBound'");
  }
  if (definition.indexNeeds === undefined || definition.usedProperties === undefined || definition.referenceParams?.entityType !== spec.entityTypeParam) throw new CatalogError(definition.id, 'declares a shared attribute read and does not name its indexes, the properties it uses and the reference of its anchor');
}

/**
 * The supports template's own declaration: its Cypher is exactly the one `@derivedSupport(<rule parameter>)` marker, its schema has the rule ID as text and the two ends as a list that it reads back as references, it is
 * not paged and not profiled, its cut means a lower bound, it names the stable-ID indexes it needs and the properties it uses.
 */
function checkDerivedSupport(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'derivedSupport');
  const spec = definition.derivedSupport;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the derived support marker without declaring a supports read');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.ruleParam || definition.cypher !== `@derivedSupport(${spec.ruleParam})`) throw new CatalogError(definition.id, 'declares a supports read and its Cypher is not exactly its one derived support marker');
  if (shape.properties.get(spec.ruleParam) !== 'string' || shape.properties.get(spec.endsParam) !== 'array' || definition.referenceLists?.includes(spec.endsParam) !== true) throw new CatalogError(definition.id, 'declares a supports read for parameters its schema does not have as text and a list, or does not list the ends as reference lists');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.relatedContext !== undefined || definition.derivedRule !== undefined || definition.paged || definition.profile === true || definition.cutMeans !== 'lowerBound') {
    throw new CatalogError(definition.id, "declares a supports read and is also another kind of template, paged, profiled or not declared cutMeans: 'lowerBound'");
  }
  if (definition.indexNeeds === undefined || definition.usedProperties === undefined) throw new CatalogError(definition.id, 'declares a supports read and does not name its indexes and the properties it uses');
  if (definition.referenceParams !== undefined) throw new CatalogError(definition.id, 'declares reference lists and reference parameters, of which the gate reads back one kind only');
}

/**
 * The edge template's own declaration: its Cypher is exactly the one `@edgeLoad(<type parameter>)` marker, its schema has the three text parameters it names and the stable ID (its integer form is derived from it), it is not paged, its cut means a duplicate,
 * and it names the index of the relationship's `stable_id` it needs, and the properties it uses.
 */
function checkEdgeLoad(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'edgeLoad');
  const spec = definition.edgeLoad;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the edge load marker without declaring an edge load');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.typeParam || definition.cypher !== `@edgeLoad(${spec.typeParam})`) throw new CatalogError(definition.id, 'declares an edge load and its Cypher is not exactly its one edge load marker');
  const list = spec.listParam;
  if (list !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(list)) throw new CatalogError(definition.id, 'declares an edge load for a list parameter that is not a plain name');
  const hasIds = list === undefined ? shape.properties.has('stableId') : shape.properties.get(list) === 'array' && !shape.properties.has('stableId');
  if (![spec.typeParam, spec.fromParam, spec.toParam].every((name) => shape.properties.get(name) === 'string') || !hasIds) throw new CatalogError(definition.id, 'declares an edge load for parameters its schema does not have');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.relatedContext !== undefined || definition.paged || definition.profile === true || (list === undefined ? definition.cutMeans !== 'duplicate' || definition.boundedBy !== undefined : definition.rows !== 'bounded' || definition.cutMeans !== undefined || definition.boundedBy !== list)) {
    throw new CatalogError(definition.id, "declares an edge load and is also another kind of template, paged, profiled or not declared cutMeans: 'duplicate' (a read of a list of IDs is declared rows: 'bounded' and bounded by that list instead)");
  }
  if (definition.indexNeeds === undefined || definition.usedProperties === undefined) throw new CatalogError(definition.id, 'declares an edge load and does not name its index and its properties');
}

/**
 * The aggregate templates' own declaration: its Cypher is exactly the one `@aggregateRead(<type parameter>)` marker, its schema has the type as text and the two ends as a list that it reads back as references, it returns one row
 * (`rows: 'one'`), it is not paged and not profiled, and it names the stable-ID indexes it needs and the properties it uses.
 */
function checkAggregateRead(definition: TemplateDefinition, shape: Shape): void {
  const used = markersOf(definition.cypher).filter((marker) => marker.kind === 'aggregateRead');
  const spec = definition.aggregateRead;
  if (spec === undefined) {
    if (used.length > 0) throw new CatalogError(definition.id, 'uses the aggregate read marker without declaring an aggregate read');
    return;
  }
  if (used.length !== 1 || used[0]?.name !== spec.typeParam || definition.cypher !== `@aggregateRead(${spec.typeParam})`) throw new CatalogError(definition.id, 'declares an aggregate read and its Cypher is not exactly its one aggregate read marker');
  if (shape.properties.get(spec.typeParam) !== 'string' || shape.properties.get(spec.endsParam) !== 'array' || definition.referenceLists?.includes(spec.endsParam) !== true) throw new CatalogError(definition.id, 'declares an aggregate read for parameters its schema does not have as text and a list, or does not list the ends as reference lists');
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || definition.expandNeighbors !== undefined || definition.relatedContext !== undefined || definition.derivedRule !== undefined || definition.edgeLoad !== undefined || definition.paged || definition.profile === true || definition.rows !== 'one') {
    throw new CatalogError(definition.id, "declares an aggregate read and is also another kind of template, paged, profiled or not declared rows: 'one'");
  }
  if (definition.indexNeeds === undefined || definition.usedProperties === undefined) throw new CatalogError(definition.id, 'declares an aggregate read and does not name its indexes and the properties it uses');
}

/** A template that reads a node by its reference names two parameters its schema has: the entity type (a declared entity parameter) and the stable ID. */
function checkReferenceParams(definition: TemplateDefinition, shape: Shape): void {
  const names = definition.referenceParams;
  if (names === undefined) return;
  if (!definition.entityParams.includes(names.entityType) || !shape.properties.has(names.entityType) || !shape.properties.has(names.stableId)) throw new CatalogError(definition.id, 'declares reference parameters its schema or its entity parameters do not have');
}

/** A template that is not paged says what its rows are, one aggregate row or a read whose cut means a duplicate or a lower bound, and a paged one says none of them. */
function checkRows(definition: TemplateDefinition): void {
  const declared = (definition.rows === undefined ? 0 : 1) + (definition.cutMeans === undefined ? 0 : 1);
  if (definition.paged && declared > 0) throw new CatalogError(definition.id, 'is paged and declares rows or cutMeans');
  if (!definition.paged && declared !== 1) throw new CatalogError(definition.id, "is not paged and does not declare exactly one of rows: 'one', rows: 'bounded', cutMeans: 'duplicate' or cutMeans: 'lowerBound'");
}

/** A template that names hops declares an integer parameter its schema has and a maximum from 1 to the ceiling of the mapping's `max_hops`. */
function checkHops(definition: TemplateDefinition, shape: Shape): void {
  const hops = definition.hops;
  if (hops === undefined) return;
  if (shape.properties.get(hops.param) !== 'integer') throw new CatalogError(definition.id, 'declares a hop parameter its schema does not have as a whole number');
  if (!Number.isInteger(hops.max) || hops.max < 1 || hops.max > MAX_HOPS_CEILING) throw new CatalogError(definition.id, `declares a hop maximum outside 1 to ${MAX_HOPS_CEILING}`);
}

/** A template that reads a list is bounded by it: it is declared rows 'bounded', and the list is a parameter its schema has as a list. */
function checkBoundedBy(definition: TemplateDefinition, shape: Shape): void {
  if (definition.boundedBy === undefined) return;
  if (definition.rows !== 'bounded' || definition.paged || shape.properties.get(definition.boundedBy) !== 'array') throw new CatalogError(definition.id, "is bounded by a list its schema does not have as a list, or is not declared rows: 'bounded'");
}

function build(definition: TemplateDefinition): Template {
  const shape = shapeOf(definition);
  for (const name of RESERVED) if (shape.properties.has(name)) throw new CatalogError(definition.id, `declares the reserved parameter ${name}`);
  // only the gate's `@entityType` placeholder reads the branch entity types, at the position of its own branch
  const texts = [definition.cypher, ...(definition.searchBranches === undefined ? [] : [definition.searchBranches.value, definition.searchBranches.text])];
  if (texts.some((text) => BRANCH_ENTITY_TYPES_REFERENCE.test(text))) throw new CatalogError(definition.id, `reads the gate-filled parameter ${BRANCH_ENTITY_TYPES} itself`);
  checkRows(definition);
  if (definition.paged && definition.expandNeighbors === undefined && !PAGED_LIMIT.test(definition.cypher)) throw new CatalogError(definition.id, 'is paged and its Cypher has no LIMIT $limit + 1');
  checkProfile(definition);
  checkMarkers(definition, shape);
  checkSearchBranches(definition, shape);
  checkFacetProbes(definition, shape);
  checkDegreeCounts(definition, shape);
  checkExpandNeighbors(definition, shape);
  checkRelatedContext(definition, shape);
  checkDerivedRule(definition, shape);
  checkDerivedSupport(definition, shape);
  checkSharedAttribute(definition, shape);
  checkEdgeLoad(definition, shape);
  checkAggregateRead(definition, shape);
  checkBoundedBy(definition, shape);
  checkHops(definition, shape);
  checkReferenceParams(definition, shape);
  checkGateParameters(definition, shape);
  const integerParameters = [...shape.properties].flatMap(([name, type]) => (type === 'integer' ? [name] : []));
  return { ...definition, integerParameters };
}

export interface CatalogOptions {
  readonly templates: readonly TemplateDefinition[];
  readonly isEnabled?: (templateId: string, sourceId: string) => boolean;
}

export function createTemplateCatalog(options: CatalogOptions): TemplateCatalog {
  const templates = new Map<string, Template>();
  for (const definition of options.templates) {
    if (templates.has(definition.id)) throw new CatalogError(definition.id, 'has an id that another template already uses');
    templates.set(definition.id, build(definition));
  }
  const enabled = options.isEnabled ?? (() => true);
  return {
    find: (templateId) => templates.get(templateId),
    isEnabled: (templateId, sourceId) => enabled(templateId, sourceId),
  };
}
