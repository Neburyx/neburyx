import { AppError } from '../errors.js';
import type { GateContext, GateRequest, Params, Template, TemplateCatalog } from './types.js';

export interface Validated {
  readonly template: Template;
  readonly params: Params;
}

export function findTemplate(catalog: TemplateCatalog, request: GateRequest): Template {
  const template = catalog.find(request.templateId);
  if (!template) throw new AppError('INVALID_REQUEST');
  return template;
}

export function validateRequest(catalog: TemplateCatalog, template: Template, request: GateRequest, context: GateContext): Validated {
  if (!catalog.isEnabled(template.id, context.sourceId)) throw new AppError('INVALID_REQUEST');
  const parsed = template.paramsSchema.safeParse(request.params);
  if (!parsed.success) throw new AppError('INVALID_REQUEST');
  if (!Number.isInteger(request.limit) || request.limit < 1) throw new AppError('INVALID_REQUEST');
  if (request.limit > context.budgets.maxPage) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxPage: context.budgets.maxPage });
  if (template.refsOf(parsed.data).some((ref) => ref.sourceId !== context.sourceId)) throw new AppError('SOURCE_MISMATCH');
  return { template, params: parsed.data };
}
