import { AppError } from '../errors.js';
import type { GateParameter, Params, SourceAllowlist, Template } from './types.js';

/**
 * A marker in a template's Cypher, such as `@entity(kind)`, `@relationship(via)` or `@stableId(kind)`; the name in the brackets is a parameter name.
 * `@stableId(kind)` writes the `stable_id` property of the entity type that the parameter `kind` names.
 */
const MARKER = /@(entity|relationship|stableId)\(([A-Za-z][A-Za-z0-9]*)\)/g;
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

export type MarkerKind = 'entity' | 'relationship' | 'stableId';

export function markersOf(cypher: string): { readonly kind: MarkerKind; readonly name: string }[] {
  return [...cypher.matchAll(MARKER)].flatMap((match) => {
    const [, kind, name] = match;
    return (kind === 'entity' || kind === 'relationship' || kind === 'stableId') && name !== undefined ? [{ kind, name }] : [];
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
  const cypher = template.cypher.replace(MARKER, (_whole, kind: string, name: string) => {
    const replacement = replacements.get(`${kind}:${name}`) ?? '';
    return kind === 'relationship' ? replacement : quoteName(replacement);
  });
  const markerNames = new Set([...template.entityParams, ...template.relationshipParams]);
  const kept = Object.entries(params).filter(([key]) => !markerNames.has(key));
  return { cypher, parameters: Object.fromEntries([...kept, ['limit', limit], ...gateValuesOf(template, allowlist)]) };
}
