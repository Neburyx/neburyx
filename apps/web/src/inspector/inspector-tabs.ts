import type { ComponentType } from 'react';
import type { ElementRef, GraphNode } from '@neburyx/contracts';
import type { EntityRead } from './entity-read.js';
import { createOrderedRegistry, useOrdered, type Ordered, type OrderedRegistry } from './ordered-registry.js';

export interface InspectorTabProps {
  /** The entity as the inspector shows it: the entity read's answer once there is one, the loaded node until then. */
  readonly node: GraphNode;
  readonly entity: ElementRef;
  readonly read: EntityRead;
}

export interface InspectorTab extends Ordered {
  readonly label: string;
  readonly content: ComponentType<InspectorTabProps>;
}

export type InspectorTabRegistry = OrderedRegistry<InspectorTab>;

export const createInspectorTabRegistry = (): InspectorTabRegistry => createOrderedRegistry<InspectorTab>();
export const useInspectorTabs = (registry: InspectorTabRegistry): readonly InspectorTab[] => useOrdered(registry);

export interface NeighborRow extends Ordered {
  /** A row of the Overview's sourced neighbors section, drawn after the per-type rows. */
  readonly content: ComponentType<{ readonly entity: ElementRef }>;
}

export type NeighborRowRegistry = OrderedRegistry<NeighborRow>;

export const createNeighborRowRegistry = (): NeighborRowRegistry => createOrderedRegistry<NeighborRow>();
