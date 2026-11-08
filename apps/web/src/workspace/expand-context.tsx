import { createContext, useContext, type ReactNode } from 'react';
import type { ElementRef, SourceProfile } from '@neburyx/contracts';
import type { ExpandStore } from '../api/expand-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { nodeRefOfKey } from '../state/keys.js';
import { useStoreSelector } from '../state/store.js';
import type { TypeFilter } from '../state/presentation-state.js';
import { NO_TYPE_FILTER } from '../state/presentation-state.js';
import { useClientStateWhenProvided } from '../state/context.js';
import { FILTERS_LEAVE_NOTHING, NO_NEIGHBOR_TYPES, cannotExpandText, narrowedExpansionText } from './expand-copy.js';
import { relationshipOptions } from './supernode-options.js';

const ExpandContext = createContext<ExpandStore | undefined>(undefined);

export function ExpandProvider({ store, children }: { readonly store: ExpandStore; readonly children: ReactNode }) {
  return <ExpandContext.Provider value={store}>{children}</ExpandContext.Provider>;
}

/** The store when one is provided, and nothing in a part of the app drawn without expansions. */
export function useExpandStoreWhenProvided(): ExpandStore | undefined {
  return useContext(ExpandContext);
}

export function useExpandStore(): ExpandStore {
  const store = useContext(ExpandContext);
  if (store === undefined) throw new Error('the expansions are not provided');
  return store;
}

/** Every entity type at the other end of a mapped relationship of the entity type, each once, in the order of the mapping. */
export function neighborTypesOf(profile: SourceProfile | undefined, entityType: string): readonly string[] {
  const ends = (profile?.relationshipTypes ?? []).flatMap((row) => [...(row.from === entityType ? [row.to] : []), ...(row.to === entityType ? [row.from] : [])]);
  return [...new Set(ends)];
}

export type ExpandResult = 'started' | 'no-stable-id' | 'no-neighbor-types' | 'nothing-left';

/** The relationship types to send for the neighbor types asked of an entity of a type: those the mapping gives between them that are on; nothing (all sourced types) while no relationship type that joins the entity type is off. */
export function relTypesToSend(profile: SourceProfile | undefined, filter: TypeFilter, entityType: string, neighborTypes: readonly string[]): readonly string[] | undefined {
  const options = relationshipOptions(profile, entityType);
  if (!options.some((option) => filter.offRelationshipTypes.has(option.type))) return undefined;
  return options.filter((option) => !filter.offRelationshipTypes.has(option.type) && option.neighborTypes.some((type) => neighborTypes.includes(type))).map((option) => option.type);
}

/** The listed neighbor types of an entity type that start unticked in a checklist: those the filters leave out of an expansion; none when the filters leave the entity nothing, so the person is never stopped. */
export function startUntickedTypes(profile: SourceProfile | undefined, filter: TypeFilter, entityType: string, listed: readonly string[]): readonly string[] {
  const planned = planExpansion(profile, filter, entityType).neighborTypes;
  if (planned.length === 0) return [];
  const mapped = neighborTypesOf(profile, entityType);
  return listed.filter((type) => filter.offEntityTypes.has(type) || (mapped.includes(type) && !planned.includes(type)));
}

export interface ExpansionPlan {
  /** The neighbor types to ask: on, and joined to the entity by at least one relationship type that is on. */
  readonly neighborTypes: readonly string[];
  readonly relTypes: readonly string[] | undefined;
  /** What the filters narrowed, in the words of the notes line; nothing when they narrowed nothing. */
  readonly note: string | undefined;
}

/** What an expansion of an entity of a type asks under the filters. */
export function planExpansion(profile: SourceProfile | undefined, filter: TypeFilter, entityType: string): ExpansionPlan {
  const mapped = neighborTypesOf(profile, entityType);
  const options = relationshipOptions(profile, entityType);
  const narrowedByRelationships = options.some((option) => filter.offRelationshipTypes.has(option.type));
  const neighborTypes = mapped.filter((type) => !filter.offEntityTypes.has(type) && (!narrowedByRelationships || options.some((option) => !filter.offRelationshipTypes.has(option.type) && option.neighborTypes.includes(type))));
  const relTypes = relTypesToSend(profile, filter, entityType, neighborTypes);
  const narrowed = neighborTypes.length < mapped.length || relTypes !== undefined;
  return { neighborTypes, relTypes, note: narrowed ? narrowedExpansionText(neighborTypes.length, mapped.length, relTypes === undefined ? undefined : { asked: relTypes.length, total: options.length }) : undefined };
}

/** What a command that expands a node needs: the node it names, the neighbor types the mapping gives it, and the store that loads them. */
export interface ExpansionControls {
  /** Loads the first page of every mapped neighbor type of the node, as one request; nothing is requested for a key that names no node with a stable ID. */
  expandNode(key: string): ExpandResult;
  readonly store: ExpandStore;
}

/** The controls over a store and the profile of the bound source. */
export function expansionControlsOf(store: ExpandStore, profile: SourceProfile | undefined, filter: () => TypeFilter = () => NO_TYPE_FILTER, openPanel: (key: string) => void = () => undefined): ExpansionControls {
  return {
    store,
    expandNode(key) {
      const ref: ElementRef | undefined = nodeRefOfKey(key);
      if (ref === undefined) {
        store.report(cannotExpandText(1));
        return 'no-stable-id';
      }
      const types = neighborTypesOf(profile, ref.entityType);
      if (types.length === 0) {
        store.report(NO_NEIGHBOR_TYPES);
        return 'no-neighbor-types';
      }
      const plan = planExpansion(profile, filter(), ref.entityType);
      if (plan.neighborTypes.length === 0) {
        openPanel(key);
        store.report(FILTERS_LEAVE_NOTHING);
        return 'nothing-left';
      }
      void store.expand(ref, plan.neighborTypes, plan.relTypes);
      if (plan.note !== undefined) store.report(plan.note);
      return 'started';
    },
  };
}

export function useExpansionControls(): ExpansionControls | undefined {
  const store = useContext(ExpandContext);
  const profile = useProfileWhenProvided();
  const state = useClientStateWhenProvided();
  return store === undefined ? undefined : expansionControlsOf(store, profile, () => state?.presentation.view.getState().typeFilter ?? NO_TYPE_FILTER, (key) => state?.presentation.setSupernodePanel({ key }));
}

export function useNodeExpansion(ref: ElementRef | undefined) {
  const store = useExpandStore();
  return useStoreSelector(store.view, () => (ref === undefined ? undefined : store.of(ref)));
}
