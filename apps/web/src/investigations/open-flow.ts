import type { GraphEdge, GraphNode, Investigation, InvestigationResponse, ReferenceOpenRequest, ValueOpenRequest } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { ClientState } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { isReadOnlyStatus } from '../state/investigation-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, type QueryKey } from '../state/keys.js';
import type { Activation } from '../state/client-state.js';
import { LAYOUTS } from '../state/layout-choice.js';
import { elementKey } from '../state/keys.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { isOpeningDraft, readDraftItems } from '../draft/restore.js';

export type OpenOutcome =
  | { readonly kind: 'shown'; readonly id: string; readonly activation: Activation; readonly someMissing?: true }
  | { readonly kind: 'source-unavailable'; readonly investigation: Investigation }
  /** The investigation shown has changes that could not be saved and the person did not go on without them (or the open was cancelled meanwhile): nothing was opened. */
  | { readonly kind: 'held' }
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

/** Shows an investigation whose items are read: nothing is applied when the page was left meanwhile, and the source, the investigation and the graph change together. */
function show(state: ClientState, investigation: Investigation, items: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }, context: OpenContext, signal: AbortSignal | undefined): OpenOutcome {
  if (signal?.aborted === true) return { kind: 'failed', failure: { code: 'ABORTED' } };
  const key = openedKey(investigation.sourceId, context.principalId, investigation.id, context.mask);
  try {
    const activation = state.show(
      { id: investigation.id, sourceId: investigation.sourceId, record: { title: investigation.title, caseRef: investigation.caseRef, status: investigation.status, readOnly: isReadOnlyStatus(investigation.status), version: investigation.version, save: { kind: 'unsaved' } }, resultKeys: [key], nodeRefs: items.nodes.map((node) => node.ref), edgeRefs: items.edges.map((edge) => edge.ref) },
      [{ key, result: { sourceId: investigation.sourceId, nodes: [...items.nodes], edges: [...items.edges] } }],
    );
    return { kind: 'shown', id: investigation.id, activation };
  } catch (error) {
    if (error instanceof StateError) return mismatchIn(investigation.sourceId);
    throw error;
  }
}

const nodeIdentity = (type: string, id: string): string => `${type}\u0000${id}`;

/** Puts back what the stored draft says of the view: the layout, positions, pins, hidden entities and the viewport. The type filters wait for the mapping of the source. */
function applyPresentation(state: ClientState, draft: InvestigationResponse['draft'], nodes: readonly GraphNode[]): void {
  const keys = new Map(nodes.map((node) => [nodeIdentity(node.ref.entityType, node.ref.stableId), elementKey(node.ref)]));
  const positions = new Map<string, { x: number; y: number }>();
  const pinned: string[] = [];
  const hidden: string[] = [];
  for (const entry of draft.layout.nodes) {
    const key = keys.get(nodeIdentity(entry.t, entry.id));
    if (key === undefined) continue;
    if (entry.x !== undefined && entry.y !== undefined) positions.set(key, { x: entry.x, y: entry.y });
    if (entry.pinned) pinned.push(key);
    if (entry.hidden) hidden.push(key);
  }
  const layout = LAYOUTS.find((candidate) => candidate.id === draft.layout.layout);
  if (layout !== undefined) state.presentation.setLayout(layout.id);
  if (positions.size > 0) state.presentation.setPositions(positions);
  if (pinned.length > 0) state.presentation.pin(pinned);
  if (hidden.length > 0) state.hide(hidden);
  if (draft.layout.viewport !== undefined) state.presentation.setViewport(draft.layout.viewport);
}

/** Opens an investigation by its ID: shows what the session holds without a read, else reads the investigation and, when its source is as it was, the items of its draft: its first entity when the draft is no more than that, otherwise every item the draft names, in bounded calls. */
export async function openById(client: ApiClient, state: ClientState, id: string, context: OpenContext, signal?: AbortSignal): Promise<OpenOutcome> {
  if (state.investigation.getState().id !== id && !(await draftSyncOf(state, client).settle(signal))) return { kind: 'held' };
  const held = state.resume(id, context.mask);
  if (held !== undefined) return { kind: 'shown', id, activation: held };
  const read = await client.getInvestigation(id, signal);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  const { investigation, draft } = read.value;
  if (investigation.sourceState !== 'available') return { kind: 'source-unavailable', investigation };
  const start = investigation.startingEntity;
  if (start === null) return mismatchIn(investigation.sourceId);
  const sync = draftSyncOf(state, client);
  if (isOpeningDraft(draft, start)) {
    const entity = await client.getEntity({ sourceId: investigation.sourceId, entityType: start.entityType, stableId: start.stableId }, { mask: context.mask }, signal);
    if (!entity.ok) return failedIn(investigation.sourceId, entity.failure);
    if (entity.value.ref.sourceId !== investigation.sourceId) return mismatchIn(investigation.sourceId);
    const shown = show(state, investigation, { nodes: [entity.value], edges: [] }, context, signal);
    if (shown.kind === 'shown') sync.adopt(id, { version: draft.version, notes: draft.notes, writable: true });
    return shown;
  }
  const restore = await readDraftItems(client, investigation.sourceId, context.mask, draft, signal);
  if (!restore.ok) return failedIn(investigation.sourceId, restore.failure);
  const { nodes, edges, kept, someMissing } = restore.restored;
  const shown = show(state, investigation, { nodes, edges }, context, signal);
  if (shown.kind !== 'shown') return shown;
  if (shown.activation === 'fresh') applyPresentation(state, draft, nodes);
  sync.adopt(id, { version: draft.version, notes: draft.notes, kept, filters: draft.queryContext.filters, writable: true });
  return someMissing ? { ...shown, someMissing: true } : shown;
}

/** What opens an entity: its reference as the API returned it, or a raw value to resolve; the mask comes from the context. */
export type OpenEntityRequest = Omit<ReferenceOpenRequest, 'mask'> | Omit<ValueOpenRequest, 'mask'>;

export type OpenEntityOutcome = OpenOutcome & { readonly created?: boolean };

/** Opens an entity as an investigation: the entity the answer carries is shown, so the page that follows reads nothing. */
export async function openEntity(client: ApiClient, state: ClientState, request: OpenEntityRequest, context: OpenContext, signal?: AbortSignal): Promise<OpenEntityOutcome> {
  if (!(await draftSyncOf(state, client).settle(signal))) return { kind: 'held' };
  const answer = await client.openInvestigation({ ...request, mask: context.mask }, signal);
  if (!answer.ok) return failedIn(request.sourceId, answer.failure);
  const body = answer.value;
  if (body.investigation.sourceId !== request.sourceId) return mismatchIn(request.sourceId);
  if ('entity' in body && body.entity.ref.sourceId !== body.investigation.sourceId) return mismatchIn(request.sourceId);
  if (body.investigation.sourceState !== 'available' || !('entity' in body)) return { kind: 'source-unavailable', investigation: body.investigation };
  // an investigation that was resumed has a draft of its own, which is restored whole; one that was just made holds its first entity only
  if (!body.created) return { ...(await openById(client, state, body.investigation.id, context, signal)), created: false };
  const shown = show(state, body.investigation, { nodes: [body.entity], edges: [] }, context, signal);
  if (shown.kind === 'shown') draftSyncOf(state, client).adopt(body.investigation.id, { version: body.draft.version, notes: null, writable: true });
  return { ...shown, created: true };
}
