import { DERIVED_ENTITIES, DERIVED_RULE, account, device } from './derived-fixtures.js';
import { plainRelationship } from './normalize-fixtures.js';
import { baseSource, fileOf } from './mapping.js';
import { parseMapping } from '../mapping/load.js';

export const SHARED_RELATIONSHIPS = [{ type: 'USES_TOOL', from: 'maker', to: 'tool', stable_id: 'useId', observed_at: 'seenAt' }];
export const SHARED_PRESET = { id: 'shared-tools', name: 'Shared tools', template: 'shared-attribute', bind: { anchor: 'maker', attribute: 'tool', via: 'USES_TOOL' } };

export interface SharedMappingOptions {
  readonly entities?: readonly Record<string, unknown>[];
  readonly relationships?: readonly Record<string, unknown>[];
  readonly derived?: readonly Record<string, unknown>[];
  readonly patterns?: readonly Record<string, unknown>[];
  readonly budgets?: Record<string, number>;
}

export const sharedMappingOf = (options: SharedMappingOptions = {}) =>
  parseMapping(
    fileOf(
      baseSource({
        id: 'demo',
        entities: options.entities ?? DERIVED_ENTITIES,
        relationships: options.relationships ?? SHARED_RELATIONSHIPS,
        derived: options.derived ?? [DERIVED_RULE],
        patterns: options.patterns ?? [SHARED_PRESET],
        ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
      }),
    ),
    'neburyx.yaml',
  );

export interface SharedRowOptions {
  readonly anchor?: string;
  readonly match: string;
  readonly tools?: readonly string[];
  readonly skipped?: boolean;
  readonly bounded?: boolean;
  readonly evidenceCut?: boolean;
}

/** The row of one match of a shared-attribute read: the anchor, the match, the shared attribute nodes shown and the first relationship of each side to each. */
export function sharedRow(options: SharedRowOptions) {
  const a = account(options.anchor ?? 'A-1');
  const b = account(options.match);
  const xs = (options.tools ?? ['D-1']).map((id) => device(id));
  return {
    a,
    skipped: options.skipped === true,
    bounded: options.bounded === true,
    b,
    xs,
    ras: xs.map((x) => plainRelationship('USES_TOOL', a, x, { useId: `${a.properties['makerId']}-${x.properties['toolId']}` })),
    rbs: xs.map((x) => plainRelationship('USES_TOOL', b, x, { useId: `${options.match}-${x.properties['toolId']}` })),
    shared: xs.length,
    evidenceCut: options.evidenceCut === true,
  };
}

/** The one row of a read whose anchor exists and that found no match. */
export function noMatchRow(anchor = 'A-1', flags: { readonly skipped?: boolean; readonly bounded?: boolean } = {}) {
  return { a: account(anchor), skipped: flags.skipped === true, bounded: flags.bounded === true, b: null, xs: null, ras: null, rbs: null, shared: null, evidenceCut: null };
}
