import { DERIVED_RULE } from './derived-fixtures.js';
import { plainNode, plainRelationship } from './normalize-fixtures.js';
import { linkedMappingOf } from './linked-entities-fixtures.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { patternParamsSchema } from '../gate/templates/pattern-request.js';
import type { SourceAllowlist } from '../gate/types.js';

export const PATTERN_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId', filterable: ['region', 'rank'] },
  { type: 'tool', label: 'Tool', stable_id: 'toolId', filterable: ['kind'] },
  { type: 'shop', label: 'Shop', stable_id: 'shopId' },
];
export const PATTERN_RELATIONSHIPS = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt', filterable: ['lane'] },
  { type: 'ALLIES', from: 'maker', to: 'maker', stable_id: 'allyId', filterable: ['lane'] },
  { type: 'TRUSTS', from: 'maker', to: 'maker', stable_id: 'trustId' },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'STOCKED_AT', from: 'tool', to: 'shop' },
  { type: 'ENDORSES', from: 'shop', to: 'maker', stable_id: 'endorseId' },
];

export const patternMappingOf = (budgets?: Record<string, number>) =>
  linkedMappingOf({ entities: PATTERN_ENTITIES, relationships: PATTERN_RELATIONSHIPS, derived: [DERIVED_RULE], patterns: [], ...(budgets === undefined ? {} : { budgets }) });

export function patternAllowlist(mapping = patternMappingOf()): SourceAllowlist {
  const [source] = mapping.sources;
  if (source === undefined) throw new Error('the mapping has no source');
  return allowlistFromMapping(source);
}

export const step = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });
export const patternParams = (steps: readonly Record<string, unknown>[] = [step()], over: Record<string, unknown> = {}) => ({ anchorType: 'maker', stableId: 'A-1', steps, ...over });
/** The parameters as the gate hands them to the statement: parsed, with the integer candidate added. */
export const parsedPatternParams = (steps: readonly Record<string, unknown>[] = [step()], over: Record<string, unknown> = {}) => patternParamsSchema.parse(patternParams(steps, over));

export const plainMaker = (id: string) => plainNode(['Maker'], { makerId: id });
export const plainTool = (id: string) => plainNode(['Tool'], { toolId: id });
const ID_PROPERTY: Record<string, string | undefined> = { LINKS: 'linkId', USES_TOOL: 'useId', ENDORSES: 'endorseId' };
export const plainRel = (type: string, from: { elementId: string }, to: { elementId: string }, id: string) => plainRelationship(type, from, to, ID_PROPERTY[type] === undefined ? {} : { [ID_PROPERTY[type] ?? '']: id });

/** The row of a one-step read: the anchor and one match joined by a LINKS relationship. */
export function oneStepRow(anchor: string, match: string, flags: { readonly bounded?: boolean; readonly stopListed?: boolean } = {}) {
  const [a, x] = [plainMaker(anchor), plainMaker(match)];
  return { a, bounded: flags.bounded === true, stopListed: flags.stopListed === true, heavy: [], x, mid: [], r1: plainRel('LINKS', a, x, `${anchor}>${match}`), hops: 1 };
}

/** The row of a two-step read: the anchor, a tool between and a match, over USES_TOOL out and back. */
export function twoStepRow(anchor: string, between: string, match: string) {
  const [a, t, x] = [plainMaker(anchor), plainTool(between), plainMaker(match)];
  return { a, bounded: false, stopListed: false, heavy: [], x, mid: [t], r1: plainRel('USES_TOOL', a, t, `${anchor}>${between}`), r2: plainRel('USES_TOOL', x, t, `${match}>${between}`), hops: 2 };
}

/** The one row of a read whose anchor exists and that found no match. */
export const noMatchRow = (anchor: string) => ({ a: plainMaker(anchor), bounded: false, stopListed: false, heavy: [], x: null, mid: [], r1: null, hops: 1 });
