import { DERIVED_RULE, account, device } from './derived-fixtures.js';
import { baseSource, fileOf } from './mapping.js';
import { plainNode, plainRelationship } from './normalize-fixtures.js';
import { parseMapping } from '../mapping/load.js';

export const LINKED_ENTITIES = [
  { type: 'maker', label: 'Maker', stable_id: 'makerId' },
  { type: 'tool', label: 'Tool', stable_id: 'toolId' },
  { type: 'shop', label: 'Shop', stable_id: 'shopId' },
];
export const LINKED_RELATIONSHIPS = [
  { type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' },
  { type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId' },
  { type: 'STOCKED_AT', from: 'tool', to: 'shop' },
  { type: 'ENDORSES', from: 'shop', to: 'maker', stable_id: 'endorseId' },
];
export const LINKED_PRESET = { id: 'linked-makers', name: 'Linked makers', template: 'linked-entities', bind: { anchor: 'maker', target: 'maker', via: 'LINKS' } };

export interface LinkedMappingOptions {
  readonly entities?: readonly Record<string, unknown>[];
  readonly relationships?: readonly Record<string, unknown>[];
  readonly derived?: readonly Record<string, unknown>[];
  readonly patterns?: readonly Record<string, unknown>[];
  readonly budgets?: Record<string, number>;
}

export const linkedMappingOf = (options: LinkedMappingOptions = {}) =>
  parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: options.entities ?? LINKED_ENTITIES,
        relationships: options.relationships ?? LINKED_RELATIONSHIPS,
        derived: options.derived ?? [DERIVED_RULE],
        patterns: options.patterns ?? [LINKED_PRESET],
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      }),
    ),
    'neburyx.yaml',
  );

export const maker = account;
export const tool = device;
export const shop = (id: string) => plainNode(['Shop'], { shopId: id });
export const link = (from: { elementId: string }, to: { elementId: string }, id: string) => plainRelationship('LINKS', from, to, { linkId: id });

export interface LinkedRowOptions {
  readonly anchor?: string;
  readonly match: string;
  readonly through?: string;
  readonly bounded?: boolean;
  readonly stopListed?: boolean;
  readonly heavy?: readonly string[];
}

/** The row of one match of a linked-entities read of makers: one hop, or two with a maker in between. */
export function linkedRow(options: LinkedRowOptions) {
  const a = maker(options.anchor ?? 'A-1');
  const x = maker(options.match);
  const m = options.through === undefined ? null : maker(options.through);
  return {
    a,
    bounded: options.bounded === true,
    heavy: (options.heavy ?? []).map((id) => maker(id)),
    stopListed: options.stopListed === true,
    x,
    mid: m,
    r1: m === null ? link(a, x, `${options.anchor ?? 'A-1'}>${options.match}`) : link(a, m, `${options.anchor ?? 'A-1'}>${options.through}`),
    r2: m === null ? null : link(m, x, `${options.through}>${options.match}`),
    hops: m === null ? 1 : 2,
  };
}

/** The one row of a read whose anchor exists and that found no match. */
export function noLinkedRow(anchor = 'A-1', flags: { readonly bounded?: boolean; readonly heavy?: readonly string[]; readonly stopListed?: boolean } = {}) {
  return { a: maker(anchor), bounded: flags.bounded === true, heavy: (flags.heavy ?? []).map((id) => maker(id)), stopListed: flags.stopListed === true, x: null, mid: null, r1: null, r2: null, hops: null };
}
