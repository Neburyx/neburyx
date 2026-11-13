import { ASK_PLAN_PARAMS, storedSavedPatternParamsSchema, type AskPlan } from '@neburyx/contracts';

type TemplateId = keyof typeof ASK_PLAN_PARAMS;
type TemplatePlan = Extract<AskPlan, { kind: 'plan' }>;

export type EditedParams = { readonly status: 'ok'; readonly params: TemplatePlan['params'] } | { readonly status: 'other-source' } | { readonly status: 'invalid' };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Where a template's parameters hold references: the anchor `ref`, or the two `ends` of a derived edge. */
function anchorsOf(templateId: TemplateId, params: Record<string, unknown>): unknown[] {
  if (templateId === 'derived-edge-support') return Array.isArray(params['ends']) ? params['ends'] : [];
  if (templateId === 'search') return [];
  return [params['ref']];
}

/**
 * The parameters of an edit as the plan schema takes them. Every reference of an edit carries the source it is in, which must be the plan's own (invariant 2); the source is then dropped, because
 * a stored plan names its source once, and the parameters are checked against the schema of the template the plan is for, which allows no field it does not name.
 */
export function editedParams(templateId: TemplateId, params: Record<string, unknown>, sourceId: string): EditedParams {
  const anchors = anchorsOf(templateId, params);
  if (anchors.some((anchor) => isRecord(anchor) && typeof anchor['sourceId'] === 'string' && anchor['sourceId'] !== sourceId)) return { status: 'other-source' };
  const without = (anchor: unknown): unknown => {
    if (!isRecord(anchor)) return anchor;
    const { sourceId: _own, ...rest } = anchor;
    return rest;
  };
  const stripped: Record<string, unknown> = { ...params };
  if (templateId === 'derived-edge-support') {
    if (Array.isArray(params['ends'])) stripped['ends'] = params['ends'].map(without);
  } else if (templateId !== 'search') {
    stripped['ref'] = without(params['ref']);
  }
  // a reference that names no source as text is not one the edit can tell the source of
  if (anchors.some((anchor) => !isRecord(anchor) || typeof anchor['sourceId'] !== 'string')) return { status: 'invalid' };
  const parsed = ASK_PLAN_PARAMS[templateId].safeParse(stripped);
  return parsed.success ? { status: 'ok', params: parsed.data as TemplatePlan['params'] } : { status: 'invalid' };
}

export type EditedPatternParams = { readonly status: 'ok'; readonly params: { readonly patternId: string; readonly patternVersion: number; readonly ref: { readonly entityType: string; readonly stableId: string } } } | { readonly status: 'other-source' } | { readonly status: 'invalid' };

/**
 * The parameters of an edit of a saved-pattern plan: only the starting entity may change. The pattern's id and version are the plan's own, and the reference carries the plan's source; anything else, or a missing reference,
 * is invalid, and a plan that holds no reference (its pattern holds the starting entity) has nothing to edit.
 */
export function editedPatternParams(current: { readonly patternId: string; readonly patternVersion: number }, params: Record<string, unknown>, sourceId: string): EditedPatternParams {
  const { ref, ...rest } = params;
  if (!isRecord(ref) || typeof ref['sourceId'] !== 'string') return { status: 'invalid' };
  if (ref['sourceId'] !== sourceId) return { status: 'other-source' };
  const { sourceId: _own, ...anchor } = ref;
  const parsed = storedSavedPatternParamsSchema.safeParse({ ...rest, ref: anchor });
  if (!parsed.success || parsed.data.ref === undefined) return { status: 'invalid' };
  if (parsed.data.patternId !== current.patternId || parsed.data.patternVersion !== current.patternVersion) return { status: 'invalid' };
  return { status: 'ok', params: { patternId: parsed.data.patternId, patternVersion: parsed.data.patternVersion, ref: parsed.data.ref } };
}
