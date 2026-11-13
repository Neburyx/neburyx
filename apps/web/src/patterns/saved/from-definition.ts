import { patternDefinitionSchema, type ExpandFilter, type FilterValue, type PatternDefinition } from '@neburyx/contracts';
import type { ConditionRow, WindowDraft } from '../builder/conditions.js';
import { EMPTY_DRAFT, type Draft, type StepDraft } from '../builder/model.js';

const textOf = (value: FilterValue): string => (typeof value.value === 'string' ? value.value : String(value.value));

function rowOf(id: number, filter: ExpandFilter): ConditionRow {
  const base = { id, on: filter.on, property: filter.property, op: filter.op, text: '', from: '', to: '' } as const;
  if (filter.op === 'eq') return { ...base, text: textOf(filter.value), kind: filter.value.kind };
  if (filter.op === 'in') return { ...base, text: filter.values.map(textOf).join(', '), kind: filter.values[0]?.kind ?? 'auto' };
  return { ...base, from: filter.from === undefined ? '' : textOf(filter.from), to: filter.to === undefined ? '' : textOf(filter.to), kind: (filter.from ?? filter.to)?.kind ?? 'auto' };
}

const windowOf = (window: NonNullable<PatternDefinition['steps'][number]['window']>): WindowDraft => ('days' in window ? { kind: 'days', text: String(window.days) } : { kind: 'dates', from: window.from, to: window.to });

/**
 * The builder's draft for a stored definition: each condition's values back to the text the editors take, each with the kind it was stored with, and the window to its draft. A definition that no longer passes the schema has no draft to show,
 * and the result says so, so that the builder opens empty with the reasons beside it.
 */
export function fromDefinition(definition: unknown): { readonly draft: Draft; readonly whole: boolean } {
  const parsed = patternDefinitionSchema.safeParse(definition);
  if (!parsed.success) return { draft: EMPTY_DRAFT, whole: false };
  let next = 1;
  const steps: StepDraft[] = parsed.data.steps.map((step) => {
    const conditions = (step.conditions ?? []).map((filter) => rowOf(next++, filter));
    return {
      direction: step.direction,
      arrivesAt: step.arrivesAt,
      relationshipTypes: [...step.relationshipTypes],
      ...(conditions.length === 0 ? {} : { conditions }),
      ...(step.window === undefined ? {} : { window: windowOf(step.window) }),
    };
  });
  return { draft: { anchorType: parsed.data.anchorType, steps }, whole: true };
}
