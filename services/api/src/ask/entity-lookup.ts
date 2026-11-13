import type { AskEntityLookup } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { EntityReader } from '../entities/entity-reader.js';
import type { AskSearchContext } from './entity-search.js';

/** Whether the source of the request holds the entity a reference names, by the gated entity read; the read counts against the request limiter as a search does. A reference of another source is never read. */
export function createAskEntityLookup(reader: EntityReader, context: AskSearchContext): AskEntityLookup {
  return async (ref, signal) => {
    if (ref.sourceId !== context.sourceId) return false;
    try {
      await reader.read({ ...context, entityType: ref.entityType, stableId: ref.stableId, rate: 'count', signal });
      return true;
    } catch (error) {
      if (error instanceof AppError && error.code === 'NOT_FOUND') return false;
      throw error;
    }
  };
}
