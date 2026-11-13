import { AppError } from '../errors.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { readToken } from '../reference/token.js';
import { mapPositionReferences } from './cursor/references.js';
import type { CursorPosition } from './cursor/codec.js';
import { canonicalJson, filterHashOf } from './cursor/binding.js';
import { hopCap } from './hops.js';
import type { CursorBinding, CursorCodec } from './cursor/codec.js';
import { renderTemplate, type Rendered } from './render.js';
import type { GateContext, GateRequest, Params, Template, TemplateCatalog } from './types.js';

export interface Validated {
  readonly template: Template;
  readonly params: Params;
  readonly rendered: Rendered;
  /** What a cursor of this read is bound to; the next page's cursor is signed for it. */
  readonly binding: CursorBinding;
  /** For a template that counts its hits across pages: the hits of the pages before this one, as the signed cursor carried them; 0 on the first page. */
  readonly held: number;
}

/** The field of a cursor position that carries the hits of the earlier pages, for a template that counts them (`heldOf`); the gate writes and reads it, the template never sees it. */
export const HELD_FIELD = 'held';

/** The verified position split into the template's own fields and the count of hits it carries; a template that counts hits refuses a position without a whole, non-negative count. */
function splitHeld(template: Template, position: CursorPosition | null): { readonly position: CursorPosition | null; readonly held: number } {
  if (template.heldOf === undefined || position === null) return { position, held: 0 };
  const { [HELD_FIELD]: held, ...rest } = position;
  if (typeof held !== 'number' || !Number.isSafeInteger(held) || held < 0) throw new AppError('CURSOR_INVALIDATED');
  return { position: rest, held };
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

/** The lists of references a template names, with the token in each element of a keyed entity type replaced by the value it stands for; an element that is not an object with an entity type and a stable ID is left for the schema to refuse. */
function readReferenceLists(names: readonly string[], params: object, context: GateContext, references: ReferenceKeys): unknown {
  const lists = Object.fromEntries(
    names.map((name) => {
      const list: unknown = Object.getOwnPropertyDescriptor(params, name)?.value;
      if (!Array.isArray(list)) return [name, list];
      return [
        name,
        list.map((entry: unknown) => {
          if (typeof entry !== 'object' || entry === null) return entry;
          const entityType: unknown = Object.getOwnPropertyDescriptor(entry, 'entityType')?.value;
          const stableId: unknown = Object.getOwnPropertyDescriptor(entry, 'stableId')?.value;
          if (typeof entityType !== 'string' || typeof stableId !== 'string' || context.model.entitiesByType.get(entityType)?.keyed !== true) return entry;
          return { ...entry, stableId: readToken(references, { sourceId: context.sourceId, entityType }, stableId) };
        }),
      ];
    }),
  );
  return { ...params, ...lists };
}

/** The parameters with the token of a keyed entity type's stable ID replaced by the value it stands for; any other parameters are returned as they are, for the schema to check. */
function readReferences(template: Template, params: unknown, context: GateContext, references: ReferenceKeys): unknown {
  if (typeof params === 'object' && params !== null && template.referenceLists !== undefined) return readReferenceLists(template.referenceLists, params, context, references);
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
  const hops = template.hops;
  if (hops !== undefined) {
    const value: unknown = Object.getOwnPropertyDescriptor(parsed.data, 'listParam' in hops ? hops.listParam : hops.param)?.value;
    const requested: unknown = 'listParam' in hops && Array.isArray(value) ? value.length : value;
    // a schema that leaves the declared parameter out of what it parses would skip the bound, so that is a defect and never a pass
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested)) throw new AppError('INTERNAL_ERROR');
    const cap = hopCap(hops.max, context.budgets);
    if (requested > cap) throw new AppError('QUERY_BUDGET_EXCEEDED', { maxHops: cap });
  }
  // a masked field is not an oracle: while masking is asked, a request cannot search, filter or sort by a pii field
  if (context.mask) {
    for (const used of template.usedProperties?.(parsed.data, context.allowlist) ?? []) {
      if ('entityType' in used && used.use !== 'fixed-order' && context.model.entitiesByType.get(used.entityType)?.pii.includes(used.property) === true) throw new AppError('INVALID_REQUEST');
    }
  }
  // a read of a list answers a row for each element at most, so the limit covers the list and no row is ever cut
  if (template.boundedBy !== undefined) {
    const list: unknown = Object.getOwnPropertyDescriptor(parsed.data, template.boundedBy)?.value;
    if (!Array.isArray(list) || list.length > request.limit) throw new AppError('INVALID_REQUEST');
  }
  const refs = template.refsOf(parsed.data);
  if (refs.some((ref) => ref.sourceId !== context.sourceId)) throw new AppError('SOURCE_MISMATCH');
  if (refs.some((ref) => !context.allowlist.entityLabels.has(ref.entityType))) throw new AppError('INVALID_REQUEST');
  const binding: CursorBinding = {
    source: context.sourceId,
    principal: context.principal.id,
    policyVersion: context.policyVersion,
    filterHash: filterHashOf({ params: parsed.data, mask: context.mask }, references.filterHash),
    sort: template.sort ?? '',
    target: template.id,
    targetVersion: template.version,
  };
  if (request.cursor !== undefined && !template.paged) throw new AppError('INVALID_REQUEST');
  const rendered = renderTemplate(template, parsed.data, context.allowlist, request.limit, context.budgets.countCap);
  if (!template.paged) return { template, params: parsed.data, rendered, binding, held: 0 };
  // the position is the one this gate signed for this request, or none; a template reads it as the parameter `cursor`
  const verified = splitHeld(template, request.cursor === undefined ? null : cursors.verify(request.cursor, binding));
  if (verified.position !== null && template.positionFits?.(verified.position) === false) throw new AppError('CURSOR_INVALIDATED');
  const position = verified.position === null ? null : readPosition(template, verified.position, context, references);
  return { template, params: parsed.data, rendered: { ...rendered, parameters: { ...rendered.parameters, cursor: position } }, binding, held: verified.held };
}
