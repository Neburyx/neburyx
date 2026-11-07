import { AppError } from '../errors.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { readToken } from '../reference/token.js';
import { mapPositionReferences } from './cursor/references.js';
import type { CursorPosition } from './cursor/codec.js';
import { canonicalJson, filterHashOf } from './cursor/binding.js';
import type { CursorBinding, CursorCodec } from './cursor/codec.js';
import { renderTemplate, type Rendered } from './render.js';
import type { GateContext, GateRequest, Params, Template, TemplateCatalog } from './types.js';

export interface Validated {
  readonly template: Template;
  readonly params: Params;
  readonly rendered: Rendered;
  /** What a cursor of this read is bound to; the next page's cursor is signed for it. */
  readonly binding: CursorBinding;
}

export function findTemplate(catalog: TemplateCatalog, request: Pick<GateRequest, 'templateId'>): Template {
  const template = catalog.find(request.templateId);
  if (!template) throw new AppError('INVALID_REQUEST');
  return template;
}

/** The position of a cursor with each stable ID it holds for a keyed entity type turned from its token back into the value, so that the keyset parameters are built from the real value. */
export function readPosition(template: Template, position: CursorPosition, context: Pick<GateContext, 'model' | 'sourceId'>, references: ReferenceKeys): CursorPosition {
  try {
    return mapPositionReferences(template, position, context, (entityType, stableId) => readToken(references, { sourceId: context.sourceId, entityType }, stableId));
  } catch {
    // a cursor this gate signed holds tokens it made; one that does not read back is a cursor that no longer fits this deployment
    throw new AppError('CURSOR_INVALIDATED');
  }
}

/** The parameters with the token of a keyed entity type's stable ID replaced by the value it stands for; any other parameters are returned as they are, for the schema to check. */
function readReferences(template: Template, params: unknown, context: GateContext, references: ReferenceKeys): unknown {
  const names = template.referenceParams;
  if (names === undefined || typeof params !== 'object' || params === null) return params;
  const entityType: unknown = Object.getOwnPropertyDescriptor(params, names.entityType)?.value;
  const stableId: unknown = Object.getOwnPropertyDescriptor(params, names.stableId)?.value;
  if (typeof entityType !== 'string' || typeof stableId !== 'string' || context.model.entitiesByType.get(entityType)?.keyed !== true) return params;
  return { ...params, [names.stableId]: readToken(references, { sourceId: context.sourceId, entityType }, stableId) };
}

export function validateRequest(catalog: TemplateCatalog, template: Template, request: Pick<GateRequest, 'params' | 'limit' | 'cursor'>, context: GateContext, cursors: CursorCodec, references: ReferenceKeys): Validated {
  if (!catalog.isEnabled(template.id, context.sourceId)) throw new AppError('INVALID_REQUEST');
  const parsed = template.paramsSchema.safeParse(readReferences(template, request.params, context, references));
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  if (!Number.isInteger(request.limit) || request.limit < 1) throw new AppError('INVALID_REQUEST');
  if (request.limit > context.budgets.maxPage) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: context.budgets.maxPage });
  // a masked field is not an oracle: while masking is asked, a request cannot search, filter or sort by a pii field
  if (context.mask) {
    for (const used of template.usedProperties?.(parsed.data) ?? []) {
      if ('entityType' in used && context.model.entitiesByType.get(used.entityType)?.pii.includes(used.property) === true) throw new AppError('INVALID_REQUEST');
    }
  }
  const refs = template.refsOf(parsed.data);
  if (refs.some((ref) => ref.sourceId !== context.sourceId)) throw new AppError('SOURCE_MISMATCH');
  if (refs.some((ref) => !context.allowlist.entityLabels.has(ref.entityType))) throw new AppError('INVALID_REQUEST');
  const binding: CursorBinding = {
    source: context.sourceId,
    principal: context.principal.id,
    policyVersion: context.policyVersion,
    filterHash: filterHashOf(parsed.data, references.filterHash),
    sort: template.sort ?? '',
    target: template.id,
    targetVersion: template.version,
  };
  if (request.cursor !== undefined && !template.paged) throw new AppError('INVALID_REQUEST');
  const rendered = renderTemplate(template, parsed.data, context.allowlist, request.limit, context.budgets.countCap);
  if (!template.paged) return { template, params: parsed.data, rendered, binding };
  // the position is the one this gate signed for this request, or none; a template reads it as the parameter `cursor`
  const position = request.cursor === undefined ? null : readPosition(template, cursors.verify(request.cursor, binding), context, references);
  return { template, params: parsed.data, rendered: { ...rendered, parameters: { ...rendered.parameters, cursor: position } }, binding };
}
