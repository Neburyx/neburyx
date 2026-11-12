import { sharedAttributeParamsSchema, type Count, type TemplateRunNotice, type TemplateRunResponse } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { allowlistFromMapping } from '../gate/allowlist.js';
import { isNormalizedShared } from '../gate/normalize/shared-attribute.js';
import { SHARED_ATTRIBUTE_ID, sharedAttributeTemplate } from '../gate/templates/shared-attribute.js';
import { sharedAttributeRequestOf } from '../gate/templates/shared-attribute-statement.js';
import type { Gate, GatePage, GateRequest, SourceAllowlist } from '../gate/types.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, PresetModel, SourceModel } from '../mapping/model.js';
import type { Principal } from '../seams/seams.js';
import { windowInstantsOf } from './template-window.js';

export interface TemplateRunServiceRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly id: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly mask: boolean;
  readonly signal?: AbortSignal;
}

export interface TemplateRunService {
  run(request: TemplateRunServiceRequest): Promise<TemplateRunResponse>;
}

const SCOPE = 'template:shared-attribute';

interface Resolved {
  readonly templateId: string;
  readonly auditAction: string;
  readonly preset: PresetModel | undefined;
}

/** What the path names for the source: one of its presets, or a built-in template by its own ID. */
function resolveId(source: SourceModel, id: string): Resolved | undefined {
  const preset = source.presets.find((candidate) => candidate.id === id);
  const templateId = preset === undefined ? id : preset.template;
  return templateId === SHARED_ATTRIBUTE_ID ? { templateId, auditAction: sharedAttributeTemplate.auditAction, preset } : undefined;
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

function noticesOf(item: { readonly skipped: boolean; readonly bounded: boolean; readonly evidenceCut: boolean }, request: { readonly stopListProperties: readonly string[]; readonly windowed: boolean }): TemplateRunNotice[] {
  return [
    ...(item.skipped ? [{ code: 'stopListSkipped' as const }] : []),
    ...(request.stopListProperties.length === 0 ? [{ code: 'noStopList' as const }] : []),
    ...(request.windowed ? [{ code: 'undatedExcluded' as const }] : []),
    ...(item.bounded ? [{ code: 'readBounded' as const }] : []),
    ...(item.evidenceCut ? [{ code: 'evidenceCut' as const }] : []),
  ];
}

export function createTemplateRunService(deps: { readonly gate: Gate; readonly mapping: MappingModel; readonly access: SourceAccess; readonly now?: () => Date }): TemplateRunService {
  const allowlists = new Map(deps.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  const now = deps.now ?? (() => new Date());
  return {
    async run(request) {
      const source = deps.mapping.sources.find((candidate) => candidate.id === request.sourceId);
      const resolved = source === undefined ? undefined : resolveId(source, request.id);
      await deps.access.require({ traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, auditAction: resolved?.auditAction ?? sharedAttributeTemplate.auditAction, rate: 'count' });
      const allowlist = allowlists.get(request.sourceId);
      if (source === undefined || allowlist === undefined || resolved === undefined) throw new AppError('NOT_FOUND');
      const { params, limit } = sharedAttributeParamsOf(request.params, resolved.preset, allowlist, source, now());
      const gateRequest: GateRequest = { traceId: request.traceId, principal: request.principal, sourceId: request.sourceId, templateId: resolved.templateId, params, limit, mask: request.mask, ...(request.signal === undefined ? {} : { signal: request.signal }) };
      let page: GatePage;
      try {
        page = await deps.gate.run(gateRequest);
      } catch (error) {
        if (error instanceof AppError && error.code === 'ACCESS_DENIED') throw new AppError('NOT_FOUND');
        throw error;
      }
      const [item] = page.items;
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
