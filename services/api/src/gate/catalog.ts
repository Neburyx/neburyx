import { z } from 'zod';
import { BRANCH_MARKER, hasStrayMarkerCharacter, markersOf } from './render.js';
import { GATE_PARAMETERS, type Template, type TemplateCatalog } from './types.js';

export type TemplateDefinition = Omit<Template, 'integerParameters'>;

export class CatalogError extends Error {
  constructor(templateId: string, problem: string) {
    super(`the template ${templateId} ${problem}`);
    this.name = 'CatalogError';
  }
}

/** Parameters the gate fills in for every template, which a template may not declare: the page limit and the verified cursor position. */
const RESERVED = ['limit', 'cursor'] as const;

const article = (kind: string): string => (kind === 'entity' ? 'an' : 'a');
/** The server-side page bound a paged template must carry, as in `LIMIT $limit + 1`. */
const PAGED_LIMIT = /LIMIT\s+\$limit\s*\+\s*1(?![\w$])/;

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
    ...markersOf(definition.cypher).filter((marker) => marker.kind !== 'searchBranches' && marker.kind !== 'facetProbes' && marker.kind !== 'degreeCounts' && marker.kind !== 'expandNeighbors'),
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
  const required = branches.allowlist === 'evidence' ? EVIDENCE_PLACEHOLDERS : ENTITY_PLACEHOLDERS;
  for (const text of [branches.value, branches.text]) {
    const placeholders = [...text.matchAll(BRANCH_MARKER)].map((match) => match[1]);
    if (!required.every((name) => placeholders.includes(name)) || !placeholders.every((name) => name !== undefined && required.includes(name)) || text.replace(BRANCH_MARKER, '').includes('@')) {
      throw new CatalogError(definition.id, `has a branch text that does not hold exactly the placeholders of its targets (${required.map((name) => `@${name}`).join(', ')})`);
    }
    if (!PAGED_LIMIT.test(text)) throw new CatalogError(definition.id, 'has a branch text with no LIMIT $limit + 1 of its own');
  }
  if (!PAGED_LIMIT.test(definition.cypher)) throw new CatalogError(definition.id, 'has search branches and its Cypher has no enclosing LIMIT $limit + 1');
  if (definition.usedProperties === undefined) throw new CatalogError(definition.id, 'has search branches and does not name the properties it uses');
  if (definition.indexNeeds === undefined) throw new CatalogError(definition.id, 'has search branches and does not name the indexes it needs');
  if (branches.allowlist !== 'search' && branches.allowlist !== 'reference' && branches.allowlist !== 'evidence') throw new CatalogError(definition.id, 'has search branches and does not say which allowlist its targets are checked against');
}

/**
 * The facet template's own declaration: it declares its facet probes exactly when its Cypher is the one `@facetProbes` marker for the list parameter its schema has, and nothing else; each of its four branch
 * texts holds exactly the placeholders of its target kind and a `LIMIT $limit + 1` of its own, and returns the one variable the probe counts (`n` for an entity target, `r` for an evidence target);
 * and it names the properties it uses and the indexes it needs, so a masked request is checked and the gate can refuse a read whose index is gone.
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
      if (!PAGED_LIMIT.test(text)) throw new CatalogError(definition.id, 'has a probe branch text with no LIMIT $limit + 1 of its own');
      if (!text.includes(kind.returns)) throw new CatalogError(definition.id, 'has a probe branch text that does not return the one variable the probe counts');
    }
  }
  if (definition.usedProperties === undefined) throw new CatalogError(definition.id, 'has facet probes and does not name the properties it uses');
  if (definition.indexNeeds === undefined) throw new CatalogError(definition.id, 'has facet probes and does not name the indexes it needs');
}

const ENTITY_PLACEHOLDERS: readonly string[] = ['label', 'property'];
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
  if (definition.searchBranches !== undefined || definition.facetProbes !== undefined || definition.degreeCounts !== undefined || !definition.paged || definition.profile === true) throw new CatalogError(definition.id, 'declares an expansion and is also another kind of template, not paged, or profiled');
  if (definition.indexNeeds === undefined || definition.readsNothing === undefined || definition.usedProperties === undefined || definition.nextPosition === undefined) throw new CatalogError(definition.id, 'declares an expansion and does not name its indexes, its empty case, its properties and its next position');
}

/** A template that reads a node by its reference names two parameters its schema has: the entity type (a declared entity parameter) and the stable ID. */
function checkReferenceParams(definition: TemplateDefinition, shape: Shape): void {
  const names = definition.referenceParams;
  if (names === undefined) return;
  if (!definition.entityParams.includes(names.entityType) || !shape.properties.has(names.entityType) || !shape.properties.has(names.stableId)) throw new CatalogError(definition.id, 'declares reference parameters its schema or its entity parameters do not have');
}

function build(definition: TemplateDefinition): Template {
  const shape = shapeOf(definition);
  for (const name of RESERVED) if (shape.properties.has(name)) throw new CatalogError(definition.id, `declares the reserved parameter ${name}`);
  if (definition.paged && definition.expandNeighbors === undefined && !PAGED_LIMIT.test(definition.cypher)) throw new CatalogError(definition.id, 'is paged and its Cypher has no LIMIT $limit + 1');
  checkProfile(definition);
  checkMarkers(definition, shape);
  checkSearchBranches(definition, shape);
  checkFacetProbes(definition, shape);
  checkDegreeCounts(definition, shape);
  checkExpandNeighbors(definition, shape);
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
