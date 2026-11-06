import type { SourceProfile } from '@neburyx/contracts';
import type { ClientState } from '../state/client-state.js';
import type { InvestigationRecord } from '../state/investigation-state.js';
import { DEFAULT_FILTER_HASH, DEFAULT_POLICY_VERSION, elementKey } from '../state/keys.js';
import { generateAddition, generateFixtureGraph } from './fixture-graph.js';

export const LOADER_MARKER = 'neburyx-dev-fixture-loader';

/** Synthetic: made-up investigation details so the header has something to show before any real investigation exists. */
export const FIXTURE_RECORD: InvestigationRecord = { title: 'Suspicious linked accounts', caseRef: 'REF-2026-1048', save: { kind: 'saved', at: '2026-10-28T09:42:00Z' } };

export interface LoaderOptions {
  /** How many connected entities are left out of the loaded refs, so the relationships that join them are loaded but cannot be drawn. */
  readonly withoutEntities?: number;
}

/** Fills the client state from a profile: records to server state, refs and a synthetic investigation record to investigation state, pins to presentation state. A refused profile changes nothing. */
export function loadFixture(state: ClientState, profile: SourceProfile, principalId: string, seed: number, options: LoaderOptions = {}): void {
  const graph = generateFixtureGraph(profile, seed);
  const connected = new Set(graph.edges.flatMap((edge) => [elementKey(edge.from), elementKey(edge.to)]));
  const left = new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((id) => connected.has(id)).slice(0, options.withoutEntities ?? 0));
  const key = { sourceId: profile.sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: `${LOADER_MARKER}:seed=${seed}`, mask: false };
  state.bindSource(profile.sourceId);
  state.putResult(key, { sourceId: profile.sourceId, nodes: graph.nodes, edges: graph.edges });
  state.setLoaded([key], graph.nodes.map((node) => node.ref).filter((ref) => !left.has(elementKey(ref))), graph.edges.map((edge) => edge.ref));
  state.replacePins(graph.pins.map(elementKey).filter((id) => !left.has(id)));
  state.describeInvestigation(FIXTURE_RECORD);
}

export const ADDED_ENTITIES = 25;

export const DISPLACED_ENTITIES = 10;

/** Stands in for dragging some entities far from where they are: puts the first unpinned entities, in the loaded order, far away from the rest, through the store function a drag uses. */
export function displaceFixtureEntities(state: ClientState, count: number = DISPLACED_ENTITIES): number {
  const pins = state.presentation.view.getState().pins;
  const keys = state.investigation.getState().nodeRefs.map(elementKey).filter((key) => !pins.has(key)).slice(0, count);
  state.presentation.setPositions(new Map(keys.map((key, index) => [key, { x: 6000 + index * 40, y: -6000 + index * 40 }] as const)));
  return keys.length;
}

export interface Added {
  readonly entities: number;
  readonly relationships: number;
}

/** Stands in for an expand until there is one: loads `ADDED_ENTITIES` more entities, each joined to one already loaded, as a result of its own, so the next call adds different ones. */
export function addFixtureEntities(state: ClientState, profile: SourceProfile, principalId: string): Added {
  const loaded = state.loadedGraph();
  const round = state.investigation.getState().resultKeys.length;
  const addition = generateAddition(profile, loaded.nodes, ADDED_ENTITIES, round);
  const key = { sourceId: profile.sourceId, principalId, policyVersion: DEFAULT_POLICY_VERSION, filterHash: DEFAULT_FILTER_HASH, params: `${LOADER_MARKER}:add=${round}`, mask: false };
  state.putResult(key, { sourceId: profile.sourceId, nodes: addition.nodes, edges: addition.edges });
  const investigation = state.investigation.getState();
  state.setLoaded([...investigation.resultKeys, key], [...investigation.nodeRefs, ...addition.nodes.map((node) => node.ref)], [...investigation.edgeRefs, ...addition.edges.map((edge) => edge.ref)]);
  return { entities: addition.nodes.length, relationships: addition.edges.length };
}
