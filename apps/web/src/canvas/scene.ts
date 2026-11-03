import type { SourceProfile } from '@neburyx/contracts';
import type { Position } from '../state/presentation-state.js';
import type { EntityLook } from './entity-look.js';
import type { RelationshipLook } from './relationship-look.js';

export interface SceneEntity {
  readonly id: string;
  readonly position: Position | undefined;
  readonly look: EntityLook;
}

export interface SceneRelationship {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly look: RelationshipLook;
}

export interface Scene {
  readonly entities: readonly SceneEntity[];
  readonly relationships: readonly SceneRelationship[];
  readonly profile: SourceProfile | undefined;
  /** Relationships that are loaded but not drawn, because an entity they join is not loaded. */
  readonly omitted: number;
  /** Whether the viewport is set to show everything when a graph is first drawn, or left as the entities' own positions give it. */
  readonly view: 'fit' | 'as-drawn';
}

export interface DrawnCounts {
  readonly entities: number;
  readonly relationships: number;
}

/** What the renderer has drawn, read back from its own styles. */
export interface Inspection {
  readonly fits: number;
  readonly interaction: { readonly panning: boolean; readonly zooming: boolean; readonly boxSelecting: boolean; readonly nodesGrabbable: boolean; readonly nodesSelectable: boolean };
  readonly nodes: readonly { readonly id: string; readonly diameter: number; readonly outline: string; readonly images: readonly string[]; readonly caption: string }[];
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string; readonly width: number; readonly color: string; readonly lineStyle: string; readonly arrow: string; readonly label: string; readonly labelOutline: number }[];
}

export interface CanvasRenderer {
  mount(container: HTMLElement | undefined): void;
  /** Draws the scene and returns the positions it chose for the entities that came without one. */
  draw(scene: Scene): ReadonlyMap<string, Position>;
  describe(): DrawnCounts;
  inspect(): Inspection;
  dispose(): void;
}

export type CreateRenderer = () => CanvasRenderer;
