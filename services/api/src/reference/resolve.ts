import type { EntityLookupRequest, OpenInvestigationRequest, ReferenceOpenRequest } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import { isKeyed, type MappingModel } from '../mapping/model.js';
import type { ReferenceKeys } from './keys.js';
import { makeToken } from './token.js';

/**
 * The reference an entity type's stable ID is carried as: for a keyed type the token of a raw value, for any other type the ID as it is. A raw value of a keyed type is accepted only when the
 * request is not masked, because naming a personal value to a masked view would let it confirm that the value exists; a reference that is already a token is passed on for the gate to read.
 * A source or an entity type the mapping does not name is passed on unchanged, for the read to answer as it answers any such request.
 */
export function canonicalStableId(mapping: MappingModel, keys: ReferenceKeys, place: { readonly sourceId: string; readonly entityType: string }, form: { readonly stableId: string } | { readonly value: string }, mask: boolean): string {
  const entity = mapping.sources.find((source) => source.id === place.sourceId)?.entities.find((type) => type.type === place.entityType);
  if ('stableId' in form) return form.stableId;
  if (entity === undefined || !isKeyed(entity)) return form.value;
  if (mask) throw new AppError('INVALID_REQUEST');
  return makeToken(keys, place, form.value);
}

export function canonicalLookup(mapping: MappingModel, keys: ReferenceKeys, request: EntityLookupRequest): { readonly entityType: string; readonly stableId: string } {
  const mask = request.mask === true;
  if ('ref' in request) return { entityType: request.ref.entityType, stableId: canonicalStableId(mapping, keys, { sourceId: request.sourceId, entityType: request.ref.entityType }, request.ref, mask) };
  return { entityType: request.value.entityType, stableId: canonicalStableId(mapping, keys, { sourceId: request.sourceId, entityType: request.value.entityType }, { value: request.value.value }, mask) };
}

/** An open request with its entity as a reference, whichever form it came in. */
export function canonicalOpen(mapping: MappingModel, keys: ReferenceKeys, request: OpenInvestigationRequest): ReferenceOpenRequest {
  const mask = request.mask === true;
  const { entity } = request;
  const stableId = canonicalStableId(mapping, keys, { sourceId: entity.sourceId, entityType: entity.entityType }, 'stableId' in entity ? entity : { value: entity.value }, mask);
  return { ...request, entity: { sourceId: entity.sourceId, entityType: entity.entityType, stableId } };
}
