import type { GraphNode, Investigation, OpenInvestigationRequest } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { ClientState } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, type QueryKey } from '../state/keys.js';
import type { Activation } from '../state/client-state.js';

export type OpenOutcome =
  | { readonly kind: 'shown'; readonly id: string; readonly activation: Activation }
  | { readonly kind: 'source-unavailable'; readonly investigation: Investigation }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly sourceId?: string };

export interface OpenContext {
  readonly principalId: string;
  readonly mask: boolean;
}

const failedIn = (sourceId: string, failure: ApiFailure): OpenOutcome => ({ kind: 'failed', failure, sourceId });
const mismatchIn = (sourceId: string): OpenOutcome => failedIn(sourceId, { code: 'SCHEMA_MISMATCH' });

export function openedKey(sourceId: string, principalId: string, investigationId: string, mask: boolean): QueryKey {
  return { sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: `open:${investigationId}`, mask };
}

/** Shows an investigation whose first entity is read: nothing is applied when the page was left meanwhile, and the source, the investigation and the graph change together. */
function show(state: ClientState, investigation: Investigation, node: GraphNode, context: OpenContext, signal: AbortSignal | undefined): OpenOutcome {
  if (signal?.aborted === true) return { kind: 'failed', failure: { code: 'ABORTED' } };
  const key = openedKey(investigation.sourceId, context.principalId, investigation.id, context.mask);
  try {
    const activation = state.show(
      { id: investigation.id, sourceId: investigation.sourceId, record: { title: investigation.title, caseRef: investigation.caseRef, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: [node.ref], edgeRefs: [] },
      [{ key, result: { sourceId: investigation.sourceId, nodes: [node], edges: [] } }],
    );
    return { kind: 'shown', id: investigation.id, activation };
  } catch (error) {
    if (error instanceof StateError) return mismatchIn(investigation.sourceId);
    throw error;
  }
}

/** Opens an investigation by its ID: shows what the session holds without a read, else reads the investigation and, when its source is as it was, its first entity. */
export async function openById(client: ApiClient, state: ClientState, id: string, context: OpenContext, signal?: AbortSignal): Promise<OpenOutcome> {
  const held = state.resume(id, context.mask);
  if (held !== undefined) return { kind: 'shown', id, activation: held };
  const read = await client.getInvestigation(id, signal);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  const { investigation } = read.value;
  if (investigation.sourceState !== 'available') return { kind: 'source-unavailable', investigation };
  const start = investigation.startingEntity;
  if (start === null) return mismatchIn(investigation.sourceId);
  const entity = await client.getEntity({ sourceId: investigation.sourceId, entityType: start.entityType, stableId: start.stableId }, { mask: context.mask }, signal);
  if (!entity.ok) return failedIn(investigation.sourceId, entity.failure);
  if (entity.value.ref.sourceId !== investigation.sourceId) return mismatchIn(investigation.sourceId);
  return show(state, investigation, entity.value, context, signal);
}

export type OpenEntityOutcome = OpenOutcome & { readonly created?: boolean };

/** Opens an entity as an investigation: the entity the answer carries is shown, so the page that follows reads nothing. */
export async function openEntity(client: ApiClient, state: ClientState, request: Omit<OpenInvestigationRequest, 'mask'>, context: OpenContext, signal?: AbortSignal): Promise<OpenEntityOutcome> {
  const answer = await client.openInvestigation({ ...request, mask: context.mask }, signal);
  if (!answer.ok) return failedIn(request.sourceId, answer.failure);
  const body = answer.value;
  if (body.investigation.sourceId !== request.sourceId) return mismatchIn(request.sourceId);
  if ('entity' in body && body.entity.ref.sourceId !== body.investigation.sourceId) return mismatchIn(request.sourceId);
  if (body.investigation.sourceState !== 'available' || !('entity' in body)) return { kind: 'source-unavailable', investigation: body.investigation };
  return { ...show(state, body.investigation, body.entity, context, signal), created: body.created };
}
