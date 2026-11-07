import type { CursorPosition } from './codec.js';
import type { GateContext, Template } from '../types.js';

/**
 * The position with the stable ID of each declared (entity type, stable ID) pair of fields changed by `change`, for a pair whose entity type is a keyed type of the source; a position that holds no
 * such pair, or a template that declares none, comes back as it is. A field that does not hold text is left alone (a cursor is checked by the template that minted it).
 */
export function mapPositionReferences(template: Template, position: CursorPosition, context: Pick<GateContext, 'model'>, change: (entityType: string, stableId: string) => string): CursorPosition {
  const pairs = template.referencePositions;
  if (pairs === undefined || pairs.length === 0) return position;
  const changed: Record<string, string | number | boolean | null> = { ...position };
  for (const pair of pairs) {
    const entityType = changed[pair.entityType];
    const stableId = changed[pair.stableId];
    if (typeof entityType === 'string' && typeof stableId === 'string' && context.model.entitiesByType.get(entityType)?.keyed === true) changed[pair.stableId] = change(entityType, stableId);
  }
  return changed;
}
