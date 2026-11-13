import { HEAVY_CONTINUE_LIMIT, linkedEntitiesParamsSchema, sharedAttributeParamsSchema, type Count, type TemplateRunNotice, type TemplateRunResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { isNormalizedLinked, type NormalizedLinked } from '../gate/normalize/linked-entities.js';
import { isNormalizedShared } from '../gate/normalize/shared-attribute.js';
import { LINKED_ENTITIES_ID, linkedEntitiesTemplate } from '../gate/templates/linked-entities.js';
import { LINKED_MAX_HOPS, linkedEntitiesRequestOf } from '../gate/templates/linked-entities-statement.js';
import { SHARED_ATTRIBUTE_ID, sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';
import { sharedAttributeRequestOf } from '../gate/templates/shared-attribute-statement.js';
import type { Gate, GatePage, GateRequest, Params, SourceAllowlist } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, PresetModel, SourceModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { defaultTemplateProbes, estimateOf, type TemplateProbe } from './template-probes.js';
import { windowInstantsOf } from './template-window.js';

export interface TemplateRunServiceRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mask: boolean;
  /** Continue a run that stopped as heavy: no estimate is read and the page is at most `HEAVY_CONTINUE_LIMIT`. */
  readonly continue?: boolean;
  readonly signal?: AbortSignal;
}

export interface TemplateRunService {
  run(request: TemplateRunServiceRequest): Promise<TemplateRunResponse>;
}

const SCOPE = 'template:shared-attribute';
const LINKED_SCOPE = 'template:linked-entities';

interface Resolved {
  readonly templateId: string;
  readonly auditAction: string;
  readonly version: string;
  readonly preset: PresetModel | undefined;
}

/** What the path names for the source: one of its presets, or a built-in template by its own ID. */
function resolveId(source: SourceModel, id: string): Resolved | undefined {
  const preset = source.presets.find((candidate) => candidate.id === id);
  const templateId = preset === undefined ? id : preset.template;
  if (templateId === SHARED_ATTRIBUTE_ID) return { templateId, auditAction: sharedAttributeTemplate.auditAction, version: sharedAttributeTemplate.version, preset };
  return templateId === LINKED_ENTITIES_ID ? { templateId, auditAction: linkedEntitiesTemplate.auditAction, version: linkedEntitiesTemplate.version, preset } : undefined;
}

/** The parameters the gate takes, from what the caller sent, the preset's binding and the clock; a preset names the types, so a caller that names them too is refused. */
function sharedAttributeParamsOf(raw: Readonly<Record<string, unknown>>, preset: PresetModel | undefined, allowlist: SourceAllowlist, source: SourceModel, now: Date): { readonly params: Record<string, unknown>; readonly limit: number } {
  const parsed = sharedAttributeParamsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  const { ref, window, minShared, limit } = parsed.data;
  if (!allowlist.entityLabels.has(ref.entityType)) throw new AppError('NOT_FOUND');
  let attributeType = parsed.data.attributeType;
  let via = parsed.data.via;
  if (preset !== undefined) {
    if (attributeType !== undefined || via !== undefined || ref.entityType !== preset.bind['anchor']) throw new AppError('INVALID_REQUEST');
    attributeType = preset.bind['attribute'];
    via = preset.bind['via'];
  }
  if (attributeType === undefined || via === undefined) throw new AppError('INVALID_REQUEST');
  const params: Record<string, unknown> = { entityType: ref.entityType, stableId: ref.stableId, attributeType, via, ...(minShared === undefined ? {} : { minShared }), ...(window === undefined ? {} : windowInstantsOf(window, now)) };
  return { params, limit: limit ?? source.budgets.defaultPage };
}

/** The parameters the gate takes for a linked-entities run, from what the caller sent, the preset's binding and the clock; a preset names the target type and the relationship type, so a caller that names them too is refused. */
function linkedEntitiesParamsOf(raw: Readonly<Record<string, unknown>>, preset: PresetModel | undefined, allowlist: SourceAllowlist, source: SourceModel, now: Date): { readonly params: Record<string, unknown>; readonly limit: number } {
  const parsed = linkedEntitiesParamsSchema.safeParse(raw);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  const { ref, window, direction, maxHops, limit } = parsed.data;
  if (!allowlist.entityLabels.has(ref.entityType)) throw new AppError('NOT_FOUND');
  let targetType = parsed.data.targetType;
  let via = parsed.data.via;
  if (preset !== undefined) {
    const [target, type] = [preset.bind['target'], preset.bind['via']];
    if (targetType !== undefined || via !== undefined || ref.entityType !== preset.bind['anchor'] || target === undefined || type === undefined) throw new AppError('INVALID_REQUEST');
    targetType = target;
    via = [type];
  }
  if (targetType === undefined || via === undefined) throw new AppError('INVALID_REQUEST');
  const params: Record<string, unknown> = { entityType: ref.entityType, stableId: ref.stableId, targetType, via, ...(direction === undefined ? {} : { direction }), ...(maxHops === undefined ? {} : { maxHops }), ...(window === undefined ? {} : windowInstantsOf(window, now)) };
  return { params, limit: limit ?? source.budgets.defaultPage };
}

function linkedNoticesOf(item: NormalizedLinked, request: ReturnType<typeof linkedEntitiesRequestOf>): TemplateRunNotice[] {
  return [
    ...(item.stopListed ? [{ code: 'stopListSkipped' as const }] : []),
    ...(request.maxHops > 1 && request.stopListed.size === 0 ? [{ code: 'noStopList' as const }] : []),
    ...(request.windowed ? [{ code: 'undatedExcluded' as const }] : []),
    ...(request.windowed && request.untimedTypes.length > 0 ? [{ code: 'windowNotApplied' as const, relationshipTypes: [...request.untimedTypes] }] : []),
    ...(item.supernodes.length > 0 ? [{ code: 'supernodesSkipped' as const, entities: [...item.supernodes] }] : []),
    ...(item.bounded ? [{ code: 'readBounded' as const }] : []),
  ];
}

function noticesOf(item: { readonly skipped: boolean; readonly bounded: boolean; readonly evidenceCut: boolean }, request: { readonly stopListProperties: readonly string[]; readonly windowed: boolean }): TemplateRunNotice[] {
  return [
    ...(item.skipped ? [{ code: 'stopListSkipped' as const }] : []),
    ...(request.stopListProperties.length === 0 ? [{ code: 'noStopList' as const }] : []),
    ...(request.windowed ? [{ code: 'undatedExcluded' as const }] : []),
    ...(item.bounded ? [{ code: 'readBounded' as const }] : []),
    ...(item.evidenceCut ? [{ code: 'evidenceCut' as const }] : []),
  ];
}

/** The page size of a continue: the product's 25, lowered by the page the caller asked for and by the source's `max_page`. */
export function continueLimitOf(requested: number | undefined, source: SourceModel): number {
  return Math.min(HEAVY_CONTINUE_LIMIT, requested ?? HEAVY_CONTINUE_LIMIT, source.budgets.maxPage);
}

/** One gate call; a source the viewer may not use answers as a missing one, as in every run. */
export async function gateRun(gate: Gate, request: GateRequest): Promise<GatePage> {
  try {
    return await gate.run(request);
  } catch (error) {
    if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
    throw error;
  }
}

/**
 * The estimate before a run (TAS §8.1): the probe's own gate call, in the same request. A probe that fails, is cancelled, finds no usable count or does not find the anchor ends the request (never an `unknown` estimate: that is only a
 * template with no probe). `heavy` is true when the probe read more matches than the source's threshold: the estimate is then a lower bound at the threshold, and the run does not start.
 */
export async function probeEstimateOf(gate: Gate, run: GateRequest, params: Params, probe: TemplateProbe, source: SourceModel, allowlist: SourceAllowlist, scope: string): Promise<{ readonly estimate: Count; readonly heavy: boolean; readonly threshold: number; readonly notices: readonly TemplateRunNotice[] }> {
  const page = await gateRun(gate, { ...run, templateId: probe.templateId, limit: 1 });
  const read = probe.read(page.items[0], params, allowlist);
  if (read === undefined) throw new AppError('INTERNAL_ERROR');
  if (!read.anchorFound) throw new AppError('NOT_FOUND');
  if (!read.usable) throw new AppError('INTERNAL_ERROR');
  const threshold = source.budgets.heavyOpThreshold;
  return { ...estimateOf(read, threshold, scope), threshold, notices: read.notices };
}

/** The stop of a heavy template run, when its probe read more matches than the source's threshold: the estimate labelled a lower bound at the threshold and no rows. */
async function heavyStopOf(gate: Gate, run: GateRequest, params: Params, probe: TemplateProbe, resolved: Resolved, source: SourceModel, allowlist: SourceAllowlist, requested: number | undefined): Promise<TemplateRunResponse | undefined> {
  const { estimate, heavy, threshold, notices } = await probeEstimateOf(gate, run, params, probe, source, allowlist, `template:${resolved.templateId}:estimate`);
  if (!heavy) return undefined;
  return {
    status: 'heavy',
    templateId: resolved.templateId,
    templateVersion: resolved.version,
    ...(resolved.preset === undefined ? {} : { presetId: resolved.preset.id }),
    estimate,
    threshold,
    continueLimit: continueLimitOf(requested, source),
    notices: [...notices],
    warnings: [],
  };
}

export function createTemplateRunService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly now?: () => Date; readonly probes?: ReadonlyMap<string, TemplateProbe> }): TemplateRunService {
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  const now = deps.now ?? (() => new Date());
  const probes = deps.probes ?? defaultTemplateProbes();
  function linkedResponseOf(item: unknown, page: GatePage, resolved: Resolved, params: Record<string, unknown>, allowlist: SourceAllowlist): TemplateRunResponse {
    if (item === undefined || !isNormalizedLinked(item) || !item.anchorFound) throw new AppError(item === undefined || isNormalizedLinked(item) ? 'NOT_FOUND' : 'INTERNAL_ERROR');
    const shown = new Set(item.nodes.map((node) => `${node.ref.entityType}\u0000${node.ref.stableId}`));
    const matches = item.matches.filter((entry) => shown.has(`${entry.match.entityType}\u0000${entry.match.stableId}`));
    const cut = page.hasMore || item.bounded || item.supernodes.length > 0 || item.stopListed;
    const count: Count = { value: matches.length, quality: cut ? 'lowerBound' : 'exact', scope: LINKED_SCOPE };
    return {
      status: 'ok',
      templateId: resolved.templateId,
      templateVersion: linkedEntitiesTemplate.version,
      ...(resolved.preset === undefined ? {} : { presetId: resolved.preset.id }),
      count,
      matchIds: matches.map((entry) => entry.match),
      links: matches.map((entry) => ({ match: entry.match, hops: entry.hops, ...(entry.through === undefined ? {} : { through: entry.through }) })),
      nodes: [...item.nodes],
      edges: [...item.edges],
      notices: linkedNoticesOf(item, linkedEntitiesRequestOf(allowlist, params)),
      warnings: [...item.warnings],
    };
  }

  return {
    async run(request) {
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      const resolved = source === undefined ? undefined : resolveId(source, request.id);
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: resolved?.auditAction ?? sharedAttributeTemplate.auditAction, rate: 'count' });
      const allowlist = allowlists.get(request.sourceId);
      if (source === undefined || allowlist === undefined || resolved === undefined) throw new AppError('NOT_FOUND');
      const { params, limit: asked } = resolved.templateId === LINKED_ENTITIES_ID ? linkedEntitiesParamsOf(request.params, resolved.preset, allowlist, source, now()) : sharedAttributeParamsOf(request.params, resolved.preset, allowlist, source, now());
      const requested = typeof request.params['limit'] === 'number' ? asked : undefined;
      // a page above the source's `max_page` is refused by the run's own gate call before anything is read, so the estimate is not read first
      const aboveMaxPage = requested !== undefined && requested > source.budgets.maxPage;
      const limit = request.continue === true && !aboveMaxPage ? continueLimitOf(requested, source) : asked;
      const gateRequest: GateRequest = { traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, templateId: resolved.templateId, params, limit, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      // a hop count above what the template and the source allow is refused by the run's own gate call too, with nothing read for the estimate
      const hops = request.params['maxHops'];
      const aboveHopCap = resolved.templateId === LINKED_ENTITIES_ID && typeof hops === 'number' && hops > Math.min(LINKED_MAX_HOPS, source.budgets.maxHops);
      const probe = request.continue === true || aboveMaxPage || aboveHopCap ? undefined : probes.get(resolved.templateId);
      if (probe !== undefined) {
        const stopped = await heavyStopOf(deps.gate, gateRequest, params, probe, resolved, source, allowlist, requested);
        if (stopped !== undefined) return stopped;
      }
      const page = await gateRun(deps.gate, gateRequest);
      const [item] = page.items;
      if (resolved.templateId === LINKED_ENTITIES_ID) return linkedResponseOf(item, page, resolved, params, allowlist);
      if (item === undefined || !isNormalizedShared(item) || !item.anchorFound) throw new AppError(item === undefined || isNormalizedShared(item) ? 'NOT_FOUND' : 'INTERNAL_ERROR');
      const shown = new Set(item.nodes.map((node) => `${node.ref.entityType}\u0000${node.ref.stableId}`));
      const matches = item.matches.filter((ref) => shown.has(`${ref.entityType}\u0000${ref.stableId}`));
      const cut = page.hasMore || item.bounded;
      const count: Count = { value: matches.length, quality: cut ? 'lowerBound' : 'exact', scope: SCOPE };
      const mapped = sharedAttributeRequestOf(allowlist, params);
      return {
        status: 'ok',
        templateId: resolved.templateId,
        templateVersion: sharedAttributeTemplate.version,
        ...(resolved.preset === undefined ? {} : { presetId: resolved.preset.id }),
        count,
        matchIds: matches,
        nodes: [...item.nodes],
        edges: [...item.edges],
        notices: noticesOf(item, mapped),
        warnings: [...item.warnings],
      };
    },
  };
}
