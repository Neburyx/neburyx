import type { GraphEdge, GraphNode, Investigation, InvestigationResponse, QueryContextDocument, ReferenceOpenRequest, ValueOpenRequest } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { ClientState, Activation } from '../state/client-state.js';
import { StateError } from '../state/errors.js';
import { readOnlyOf } from '../state/investigation-state.js';
import type { SaveState } from '../state/investigation-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, type QueryKey } from '../state/keys.js';
import { LAYOUTS } from '../state/layout-choice.js';
import { elementKey } from '../state/keys.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import type { KeptItems } from '../draft/draft-document.js';
import { isOpeningDraft, readDraftItems } from '../draft/restore.js';
import { isUnmappedStart, notReadEdge, notReadNode } from '../draft/unmapped.js';
import { mappingNoticesOf } from '../draft/mapping-notice.js';

export type OpenOutcome =
  | { readonly kind: 'shown'; readonly id: string; readonly activation: Activation; readonly someMissing?: true }
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
function show(state: ClientState, investigation: Investigation, items: { readonly nodes: readonly GraphNode[]; readonly edges: readonly GraphEdge[] }, context: OpenContext, signal: AbortSignal | undefined, save: SaveState = { kind: 'unsaved' }): OpenOutcome {
  if (signal?.aborted === true) return { kind: 'failed', failure: { code: 'ABORTED' } };
  const key = openedKey(investigation.sourceId, context.principalId, investigation.id, context.mask);
  try {
    const activation = state.show(
      { id: investigation.id, sourceId: investigation.sourceId, record: { title: investigation.title, caseRef: investigation.caseRef, status: investigation.status, readOnly: readOnlyOf(investigation.status, investigation.sourceState), sourceState: investigation.sourceState, version: investigation.version, save }, resultKeys: [key], nodeRefs: items.nodes.map((node) => node.ref), edgeRefs: items.edges.map((edge) => edge.ref) },
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

/** The write that stores the draft under the current mapping waits until the banner has been shown, and is not made for an investigation that cannot be changed. */
function adoptDraft(state: ClientState, sync: ReturnType<typeof draftSyncOf>, read: InvestigationResponse, held: { readonly notes: string | null; readonly kept?: KeptItems; readonly filters?: QueryContextDocument['filters'] }): void {
  const { investigation, draft, unmapped, mappingChange } = read;
  const canChange = investigation.status === 'open';
  const rehash = mappingChange !== undefined && canChange;
  mappingNoticesOf(state).set(mappingChange === undefined ? undefined : { investigationId: investigation.id, droppedFilters: mappingChange.droppedFilters, hasUnmapped: (unmapped?.nodes.length ?? 0) + (unmapped?.edges.length ?? 0) > 0, canChange, ...(rehash ? { onShown: () => sync.releaseRehash(investigation.id) } : {}) });
  sync.adopt(investigation.id, { version: draft.version, basedOnViewId: draft.basedOnViewId, ...held, writable: true, ...(rehash ? { rehash: true } : {}) });
}

const nodeEntryIdentity = (entry: { readonly t: string; readonly id: string }): string => nodeIdentity(entry.t, entry.id);

/**
 * Shows the saved layout of an investigation whose source was re-pointed or removed: every item the draft holds is a placeholder at its saved place, pin and hidden flag, and nothing is read from the source and nothing is adopted for writing,
 * so no autosave runs. The stored IDs are not shown (the placeholder never carries a title taken from them).
 */
function openSavedLayout(state: ClientState, read: InvestigationResponse, save: SaveState, context: OpenContext, signal: AbortSignal | undefined): OpenOutcome {
  const { investigation, draft } = read;
  const entries = new Map<string, { readonly t: string; readonly id: string }>();
  for (const entry of [...draft.layout.nodes, ...draft.queryContext.loaded.nodes]) entries.set(nodeEntryIdentity(entry), { t: entry.t, id: entry.id });
  const nodes = [...entries.values()].map((entry) => notReadNode(investigation.sourceId, entry));
  const edges = draft.queryContext.loaded.edges.map((edge) => notReadEdge(investigation.sourceId, edge));
  const shown = show(state, investigation, { nodes, edges }, context, signal, save);
  if (shown.kind === 'shown' && shown.activation === 'fresh') applyPresentation(state, draft, nodes);
  return shown;
}

/** Opens an investigation by its ID: shows what the session holds without a read, else reads the investigation and, when its source is as it was, the items of its draft: its first entity when the draft is no more than that, otherwise every item the draft names, in bounded calls. */
export async function openById(client: ApiClient, state: ClientState, id: string, context: OpenContext, signal?: AbortSignal): Promise<OpenOutcome> {
  if (state.investigation.getState().id !== id && !(await draftSyncOf(state, client).settle(signal))) return { kind: 'held' };
  const held = state.resume(id, context.mask);
  if (held !== undefined) return { kind: 'shown', id, activation: held };
  const read = await client.getInvestigation(id, signal);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  const { investigation, draft, unmapped } = read.value;
  const save: SaveState = read.value.save.state === 'saved' ? { kind: 'saved', at: read.value.save.savedAt } : { kind: 'unsaved' };
  if (investigation.sourceState !== 'available') return openSavedLayout(state, read.value, save, context, signal);
  const start = investigation.startingEntity;
  if (start === null) return mismatchIn(investigation.sourceId);
  const sync = draftSyncOf(state, client);
  if (isOpeningDraft(draft, start) && !isUnmappedStart(unmapped, start)) {
    const entity = await client.getEntity({ sourceId: investigation.sourceId, entityType: start.entityType, stableId: start.stableId }, { mask: context.mask }, signal);
    if (!entity.ok) return failedIn(investigation.sourceId, entity.failure);
    if (entity.value.ref.sourceId !== investigation.sourceId) return mismatchIn(investigation.sourceId);
    const shown = show(state, investigation, { nodes: [entity.value], edges: [] }, context, signal, save);
    if (shown.kind === 'shown') adoptDraft(state, sync, read.value, { notes: draft.notes });
    return shown;
  }
  const restore = await readDraftItems(client, investigation.sourceId, context.mask, draft, unmapped, signal);
  if (!restore.ok) return failedIn(investigation.sourceId, restore.failure);
  const { nodes, edges, kept, someMissing } = restore.restored;
  const shown = show(state, investigation, { nodes, edges }, context, signal, save);
  if (shown.kind !== 'shown') return shown;
  if (shown.activation === 'fresh') applyPresentation(state, draft, nodes);
  adoptDraft(state, sync, read.value, { notes: draft.notes, kept, filters: draft.queryContext.filters });
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
  // an investigation whose source changed is shown from its saved layout, as when it is opened by its ID
  if (!('entity' in body)) return { ...(await openById(client, state, body.investigation.id, context, signal)), created: false };
  // an investigation that was resumed has a draft of its own, which is restored whole; one that was just made holds its first entity only
  if (!body.created) return { ...(await openById(client, state, body.investigation.id, context, signal)), created: false };
  const shown = show(state, body.investigation, { nodes: [body.entity], edges: [] }, context, signal);
  if (shown.kind === 'shown') draftSyncOf(state, client).adopt(body.investigation.id, { version: body.draft.version, notes: body.draft.notes, basedOnViewId: body.draft.basedOnViewId, writable: true });
  return { ...shown, created: true };
}

export type ReplaceOutcome = { readonly kind: 'shown'; readonly someMissing: boolean } | { readonly kind: 'failed'; readonly failure: ApiFailure };

/**
 * Replaces the graph of the investigation shown with the items of the draft an open answer carries, read again through the gate, and adopts the draft as an open does, with the mapping banner and the rehash it may call for, so that autosave goes on from its version.
 * Nothing changes when a read fails.
 */
export async function replaceWithRead(client: ApiClient, state: ClientState, answer: InvestigationResponse, signal?: AbortSignal): Promise<ReplaceOutcome> {
  const { id, sourceId, record, resultKeys } = state.investigation.getState();
  const { draft, unmapped } = answer;
  const principalId = resultKeys[0]?.principalId;
  if (id === null || sourceId === null || record === null || principalId === undefined || answer.investigation.id !== id) return { kind: 'failed', failure: { code: 'SCHEMA_MISMATCH' } };
  const mask = state.mask.getState();
  const read = await readDraftItems(client, sourceId, mask, draft, unmapped, signal);
  if (!read.ok) return { kind: 'failed', failure: read.failure };
  // another investigation may have taken the place of this one while it was read
  if (state.investigation.getState().id !== id) return { kind: 'failed', failure: { code: 'ABORTED' } };
  const { nodes, edges, kept, someMissing } = read.restored;
  const key = openedKey(sourceId, principalId, id, mask);
  const save: SaveState = answer.save.state === 'saved' ? { kind: 'saved', at: answer.save.savedAt } : { kind: 'unsaved' };
  try {
    state.replace({ id, sourceId, record: { ...record, title: answer.investigation.title, status: answer.investigation.status, readOnly: readOnlyOf(answer.investigation.status, answer.investigation.sourceState), sourceState: answer.investigation.sourceState, version: answer.investigation.version, save }, resultKeys: [key], nodeRefs: nodes.map((node) => node.ref), edgeRefs: edges.map((edge) => edge.ref) }, [{ key, result: { sourceId, nodes: [...nodes], edges: [...edges] } }]);
  } catch (error) {
    if (error instanceof StateError) return { kind: 'failed', failure: { code: 'SCHEMA_MISMATCH' } };
    throw error;
  }
  applyPresentation(state, draft, nodes);
  // the drawing that stays mounted has no new graph to fit itself to, so a draft that holds no viewport asks for the view to be fitted
  if (draft.layout.viewport === undefined) state.presentation.applyLayout(new Map());
  adoptDraft(state, draftSyncOf(state, client), answer, { notes: draft.notes, kept, filters: draft.queryContext.filters });
  return { kind: 'shown', someMissing };
}
