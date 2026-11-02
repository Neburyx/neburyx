import { AppError } from '../errors.js';
import { renderTemplate, type Rendered } from './render.js';
import type { GateContext, GateRequest, Params, Template, TemplateCatalog } from './types.js';

export interface Validated {
  readonly template: Template;
  readonly params: Params;
  readonly rendered: Rendered;
}

export function findTemplate(catalog: TemplateCatalog, request: Pick<GateRequest, 'templateId'>): Template {
  const template = catalog.find(request.templateId);
  if (!template) throw new AppError('INVALID_REQUEST');
  return template;
}

export function validateRequest(catalog: TemplateCatalog, template: Template, request: Pick<GateRequest, 'params' | 'limit'>, context: GateContext): Validated {
  if (!catalog.isEnabled(template.id, context.sourceId)) throw new AppError('INVALID_REQUEST');
  const parsed = template.paramsSchema.safeParse(request.params);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  if (!Number.isInteger(request.limit) || request.limit < 1) throw new AppError('INVALID_REQUEST');
  if (request.limit > context.budgets.maxPage) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: context.budgets.maxPage });
  const refs = template.refsOf(parsed.data);
  if (refs.some((ref) => ref.sourceId !== context.sourceId)) throw new AppError('SOURCE_MISMATCH');
  if (refs.some((ref) => !context.allowlist.entityLabels.has(ref.entityType))) throw new AppError('INVALID_REQUEST');
  return { template, params: parsed.data, rendered: renderTemplate(template, parsed.data, context.allowlist, request.limit) };
}
