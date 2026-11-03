import { AppError } from '../errors.js';
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

export function validateRequest(catalog: TemplateCatalog, template: Template, request: Pick<GateRequest, 'params' | 'limit' | 'cursor'>, context: GateContext, cursors: CursorCodec): Validated {
  if (!catalog.isEnabled(template.id, context.sourceId)) throw new AppError('INVALID_REQUEST');
  const parsed = template.paramsSchema.safeParse(request.params);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  if (!Number.isInteger(request.limit) || request.limit < 1) throw new AppError('INVALID_REQUEST');
  if (request.limit > context.budgets.maxPage) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: context.budgets.maxPage });
  const refs = template.refsOf(parsed.data);
  if (refs.some((ref) => ref.sourceId !== context.sourceId)) throw new AppError('SOURCE_MISMATCH');
  if (refs.some((ref) => !context.allowlist.entityLabels.has(ref.entityType))) throw new AppError('INVALID_REQUEST');
  const binding: CursorBinding = {
    source: context.sourceId,
    principal: context.principal.id,
    policyVersion: context.policyVersion,
    filterHash: filterHashOf(parsed.data),
    sort: template.sort ?? '',
    target: template.id,
    targetVersion: template.version,
  };
  if (request.cursor !== undefined && !template.paged) throw new AppError('INVALID_REQUEST');
  const rendered = renderTemplate(template, parsed.data, context.allowlist, request.limit);
  if (!template.paged) return { template, params: parsed.data, rendered, binding };
  // the position is the one this gate signed for this request, or none; a template reads it as the parameter `cursor`
  const position = request.cursor === undefined ? null : cursors.verify(request.cursor, binding);
  return { template, params: parsed.data, rendered: { ...rendered, parameters: { ...rendered.parameters, cursor: position } }, binding };
}
