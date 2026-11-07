import { z } from 'zod';
import { AppError } from '../errors.js';
import { MAX_SEARCH_PROPERTIES } from '../mapping/model.js';
import type { GateParameter, Params, SourceAllowlist, Template } from './types.js';

/**
 * A marker in a template's Cypher, such as `@entity(kind)`, `@relationship(via)`, `@stableId(kind)` or `@searchBranches(targets)`; the name in the brackets is a parameter name.
 * `@stableId(kind)` writes the `stable_id` property of the entity type that the parameter `kind` names.
 * `@searchBranches(targets)` writes one branch for each target in the list parameter `targets`, from the template's branch text (see `Template.searchBranches`).
 */
const MARKER = /@(entity|relationship|stableId|searchBranches)\(([A-Za-z][A-Za-z0-9]*)\)/g;
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

export type MarkerKind = 'entity' | 'relationship' | 'stableId' | 'searchBranches';

export function markersOf(cypher: string): { readonly kind: MarkerKind; readonly name: string }[] {
  return [...cypher.matchAll(MARKER)].flatMap((match) => {
    const [, kind, name] = match;
    return (kind === 'entity' || kind === 'relationship' || kind === 'stableId' || kind === 'searchBranches') && name !== undefined ? [{ kind, name }] : [];
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
      const label = allowlist.entityLabels.get(target.entityType);
      if (label === undefined || (branches.allowlist === 'search' ? allowlist.searchProperties : allowlist.referenceProperties).get(target.entityType)?.includes(target.property) !== true) throw new AppError('INVALID_REQUEST');
      const key = JSON.stringify([target.entityType, target.property]);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      return branches[target.match].replace(BRANCH_MARKER, (_whole, kind: string) => quoteName(kind === 'label' ? label : target.property));
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
      const row = allowlist.evidenceRows.find((candidate) => candidate.type === target.relationshipType && candidate.from === target.from && candidate.to === target.to);
      const fromLabel = allowlist.entityLabels.get(target.from);
      const toLabel = allowlist.entityLabels.get(target.to);
      if (row === undefined || fromLabel === undefined || toLabel === undefined || !row.properties.includes(target.property)) throw new AppError('INVALID_REQUEST');
      const key = JSON.stringify([target.relationshipType, target.from, target.to, target.property]);
      if (seen.has(key)) throw new AppError('INVALID_REQUEST');
      seen.add(key);
      const names: Record<string, string> = { type: target.relationshipType, fromLabel, toLabel, property: target.property };
      return branches[target.match].replace(BRANCH_MARKER, (_whole, kind: string) => quoteName(names[kind] ?? ''));
    })
    .join(' UNION ');
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
  const cypher = template.cypher.replace(MARKER, (_whole, kind: string, name: string) => {
    if (kind === 'searchBranches') return branches;
    const replacement = replacements.get(`${kind}:${name}`) ?? '';
    return kind === 'relationship' ? replacement : quoteName(replacement);
  });
  const markerNames = new Set([...template.entityParams, ...template.relationshipParams, ...(template.searchBranches === undefined ? [] : [template.searchBranches.param])]);
  const kept = Object.entries(params).filter(([key]) => !markerNames.has(key));
  return { cypher, parameters: Object.fromEntries([...kept, ['limit', limit], ...gateValuesOf(template, allowlist)]) };
}
