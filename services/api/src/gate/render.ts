import { z } from 'zod';
import { AppError } from '../errors.js';
import { MAX_EVIDENCE_PROPERTIES, MAX_FACET_PROBES, MAX_REFERENCE_PROPERTIES, MAX_SEARCH_PROPERTIES } from '../mapping/model.js';
import type { GateParameter, Params, SourceAllowlist, Template } from './types.js';

/**
 * A marker in a template's Cypher, such as `@entity(kind)`, `@relationship(via)`, `@stableId(kind)` or `@searchBranches(targets)`; the name in the brackets is a parameter name.
 * `@stableId(kind)` writes the `stable_id` property of the entity type that the parameter `kind` names.
 * `@searchBranches(targets)` writes one branch for each target in the list parameter `targets`, from the template's branch text (see `Template.searchBranches`).
 * `@facetProbes(probes)` writes the whole statement of the facet probes (see `Template.facetProbes`).
 */
const MARKER = /@(entity|relationship|stableId|searchBranches|facetProbes)\(([A-Za-z][A-Za-z0-9]*)\)/g;
/**
 * The placeholders of a branch text: for a target of an entity type the label of the type and the property (`@label`, `@property`); for a target of a relationship mapping row the
 * relationship type, the labels of its two entity types and the property (`@type`, `@fromLabel`, `@toLabel`, `@property`).
 */
export const BRANCH_MARKER = /@(label|property|type|fromLabel|toLabel)(?![A-Za-z0-9])/g;
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

export type MarkerKind = 'entity' | 'relationship' | 'stableId' | 'searchBranches' | 'facetProbes';

export function markersOf(cypher: string): { readonly kind: MarkerKind; readonly name: string }[] {
  return [...cypher.matchAll(MARKER)].flatMap((match) => {
    const [, kind, name] = match;
    return (kind === 'entity' || kind === 'relationship' || kind === 'stableId' || kind === 'searchBranches' || kind === 'facetProbes') && name !== undefined ? [{ kind, name }] : [];
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

/** The branch of one entity target, checked against the `search` or the `reference` properties of the mapping. */
function entityBranchOf(target: { readonly entityType: string; readonly property: string }, kind: 'search' | 'reference', text: string, allowlist: SourceAllowlist): string {
  const label = allowlist.entityLabels.get(target.entityType);
  if (label === undefined || (kind === 'search' ? allowlist.searchProperties : allowlist.referenceProperties).get(target.entityType)?.includes(target.property) !== true) throw new AppError('INVALID_REQUEST');
  return text.replace(BRANCH_MARKER, (_whole, placeholder: string) => quoteName(placeholder === 'label' ? label : target.property));
}

/** The branch of one evidence target, which must be an evidence property of a relationship mapping row that has a `stable_id`, with the labels of that row's two entity types. */
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
    if (template.readsNothing?.(params) === true) return '';
    throw new AppError('INVALID_REQUEST');
  }
  const seen = new Set<string>();
  return list.data
    .map((target) => {
      const key = JSON.stringify([target.entityType, target.property]);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      return entityBranchOf(target, branches.allowlist === 'search' ? 'search' : 'reference', branches[target.match], allowlist);
    })
    .join(' UNION ');
}

/** The branches of an evidence template: one for each target, which must be an evidence property of a relationship mapping row that has a `stable_id`, with the labels of that row's two entity types. */
function evidenceBranchesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const branches = template.searchBranches;
  if (branches === undefined) return '';
  const list = z.array(evidenceTargetSchema).max(MAX_SEARCH_PROPERTIES).safeParse(params[branches.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  if (list.data.length === 0) {
    if (template.readsNothing?.(params) === true) return '';
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
 * The statement of the facet probes of a template that has them: for each probe `i` a `CALL { CALL { <its branches joined by UNION> } WITH n LIMIT $limit + 1 RETURN count(*) AS c<i> }` (`r` for a probe of
 * evidence), then one `RETURN` of every `c<i>`. A probe holds targets of one kind, each checked against the allowlist of its kind and quoted by `quoteName`; the number `i` is the position of the probe in
 * the list, written by this function and never taken from the request.
 */
function facetProbesOf(template: Template, params: Params, allowlist: SourceAllowlist): string {
  const spec = template.facetProbes;
  if (spec === undefined) return '';
  const list = z.array(z.strictObject({ targets: z.array(facetTargetSchema).max(MAX_SEARCH_PROPERTIES + MAX_REFERENCE_PROPERTIES + MAX_EVIDENCE_PROPERTIES) })).max(MAX_FACET_PROBES).safeParse(params[spec.param]);
  if (!list.success) throw new AppError('INVALID_REQUEST');
  if (list.data.length === 0) {
    if (template.readsNothing?.(params) === true) return '';
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
    return `CALL { CALL { ${branches.join(' UNION ')} } WITH ${evidence ? 'r' : 'n'} LIMIT $limit + 1 RETURN count(*) AS c${index} }`;
  });
  return `${calls.join('\n')}\nRETURN ${list.data.map((_probe, index) => `c${index}`).join(', ')}`;
}

export interface Rendered {
  readonly cypher: string;
  readonly parameters: Params;
}

/** Checks the marker parameters against the allowlist and writes the quoted names into the Cypher; every other parameter stays a parameter. */
export function renderTemplate(template: Template, params: Params, allowlist: SourceAllowlist, limit: number): Rendered {
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
  const cypher = template.cypher.replace(MARKER, (_whole, kind: string, name: string) => {
    if (kind === 'searchBranches') return branches;
    if (kind === 'facetProbes') return probes;
    const replacement = replacements.get(`${kind}:${name}`) ?? '';
    return kind === 'relationship' ? replacement : quoteName(replacement);
  });
  const markerNames = new Set([...template.entityParams, ...template.relationshipParams, ...(template.searchBranches === undefined ? [] : [template.searchBranches.param]), ...(template.facetProbes === undefined ? [] : [template.facetProbes.param])]);
  const kept = Object.entries(params).filter(([key]) => !markerNames.has(key));
  return { cypher, parameters: Object.fromEntries([...kept, ['limit', limit], ...gateValuesOf(template, allowlist)]) };
}
