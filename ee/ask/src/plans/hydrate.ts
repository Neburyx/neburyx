import { askPlanSchema, type AskPlan } from '@neburyx/contracts';
import type { PlaceholderEntry } from '../resolution/index.js';

type TemplatePlan = Extract<AskPlan, { kind: 'plan' }>;
/** What a key of the pattern catalog stood for in the request that made the plan: the pattern's own id and version. */
export interface PatternTarget {
  readonly id: string;
  readonly version: number;
}

type Anchor = { readonly entityType: string; readonly stableId: string };

export type HydrationFailure = 'unknown-placeholder' | 'not-an-entity' | 'not-a-value' | 'other-source' | 'invalid-plan';

/** Why a plan could not be turned back into what its placeholders stood for: a fixed tag, never a placeholder, a reference or a value. */
export class HydrationError extends Error {
  readonly reason: HydrationFailure;

  constructor(reason: HydrationFailure) {
    super('the plan could not be turned back into references');
    this.name = 'HydrationError';
    this.reason = reason;
  }
}

/**
 * Turns the placeholders of a plan back into what the investigator resolved them to, by the map of the same request: an entity placeholder into the whole reference it stood for (so the
 * entity type is the map's, not the model's) and the value placeholder of a search into the text typed. It substitutes only; a placeholder the map does not hold, one of the wrong kind or an
 * entity of another source than the request's fails, and nothing is stored from it.
 */
export function hydratePlan(plan: TemplatePlan, placeholders: ReadonlyMap<string, PlaceholderEntry>, sourceId: string, patterns: ReadonlyMap<string, PatternTarget> = new Map()): TemplatePlan {
  const entity = (anchor: Anchor): Anchor => {
    const entry = placeholders.get(anchor.stableId);
    if (entry === undefined) throw new HydrationError('unknown-placeholder');
    if (entry.kind !== 'entity') throw new HydrationError('not-an-entity');
    if (entry.ref.sourceId !== sourceId) throw new HydrationError('other-source');
    return { entityType: entry.ref.entityType, stableId: entry.ref.stableId };
  };
  const value = (text: string): string => {
    const entry = placeholders.get(text);
    if (entry === undefined) throw new HydrationError('unknown-placeholder');
    if (entry.kind !== 'value') throw new HydrationError('not-a-value');
    return entry.text;
  };

  let hydrated: unknown;
  switch (plan.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
    case 'entity':
    case 'degree-preview':
    case 'expand':
    case 'derived-rule-run':
      hydrated = { ...plan, params: { ...plan.params, ref: entity(plan.params.ref) } };
      break;
    case 'derived-edge-support':
      hydrated = { ...plan, params: { ...plan.params, ends: [entity(plan.params.ends[0]), entity(plan.params.ends[1])] } };
      break;
    case 'saved-pattern': {
      if (!('patternKey' in plan.params)) throw new HydrationError('invalid-plan');
      const target = patterns.get(plan.params.patternKey);
      if (target === undefined) throw new HydrationError('unknown-placeholder');
      hydrated = { ...plan, params: { patternId: target.id, patternVersion: target.version, ...(plan.params.ref === undefined ? {} : { ref: entity(plan.params.ref) }) } };
      break;
    }
    case 'search':
      hydrated = { ...plan, params: { ...plan.params, text: value(plan.params.text) } };
      break;
    default: {
      const unreachable: never = plan;
      return unreachable;
    }
  }
  const checked = askPlanSchema.safeParse(hydrated);
  if (!checked.success || checked.data.kind !== 'plan') throw new HydrationError('invalid-plan');
  return checked.data;
}
