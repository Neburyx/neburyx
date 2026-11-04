import type { SourceProfile } from '@neburyx/contracts';
import type { PointerTool, Position, Viewport } from '../state/presentation-state.js';
import type { EntityLook } from './entity-look.js';
import type { RelationshipLook } from './relationship-look.js';
import type { BoxSelection } from './box-selection.js';
import type { Click } from './selection-gestures.js';

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
  /** The source the entities belong to; a different one starts a new drawing that is fitted again. */
  readonly source: string | null;
  /** What a drag on empty canvas does. */
  readonly tool: PointerTool;
  /** The keys of the drawn entities and relationships that are selected. */
  readonly selection: ReadonlySet<string>;
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
  readonly viewport: Viewport;
  /** The zoom limits as they stand now: the minimum follows a fit that had to go below it. */
  readonly zoomLimits: { readonly min: number; readonly max: number };
  /** The box the entities cover on screen, caption space included as the fit counts it, or undefined when none is drawn. */
  readonly boundingBox: { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number } | undefined;
  readonly interaction: { readonly panning: boolean; readonly zooming: boolean; readonly boxSelecting: boolean; readonly nodesGrabbable: boolean; readonly nodesSelectable: boolean };
  readonly nodes: readonly { readonly id: string; readonly diameter: number; readonly outline: string; readonly outlineWidth: number; readonly halo: boolean; readonly images: readonly string[]; readonly caption: string }[];
  readonly edges: readonly { readonly id: string; readonly source: string; readonly target: string; readonly width: number; readonly color: string; readonly lineStyle: string; readonly arrow: string; readonly label: string; readonly labelOutline: number }[];
}

/** A right-click: the drawn item it landed on, or none for empty canvas, and where the pointer was in the browser window. */
export interface ContextMenuRequest {
  readonly target: { readonly kind: 'node' | 'relationship'; readonly key: string } | undefined;
  readonly x: number;
  readonly y: number;
}

/** What the renderer tells the canvas about the viewer's own actions. */
export interface CanvasEvents {
  /** A click on a drawn item (its key) or on empty canvas, with or without Shift; not a drag. */
  readonly click: (click: Click) => void;
  /** A box was drawn: the entities whose centre it holds, and whether Shift was held when it started. */
  readonly box: (box: BoxSelection) => void;
  /** The pan and zoom after a change, at most once per animation frame; the last report is the final view. */
  readonly viewport: (viewport: Viewport) => void;
  /** The right button was pressed and released on a drawn item or on empty canvas; the browser's own menu never opens on the canvas. */
  readonly contextMenu: (request: ContextMenuRequest) => void;
}

export interface CanvasRenderer {
  /** Shows `viewport` at once when given; with none, the first drawing that has entities is fitted (unless the scene says it is drawn as positioned). */
  mount(container: HTMLElement | undefined, events: CanvasEvents, viewport: Viewport | undefined): void;
  /** Draws the scene and returns the positions it chose for the entities that came without one. */
  draw(scene: Scene): ReadonlyMap<string, Position>;
  /** Shows every drawn entity; does nothing when none is drawn. */
  fit(): void;
  /** Multiplies the zoom around the centre of the canvas, within the zoom limits. */
  zoomBy(factor: number): void;
  describe(): DrawnCounts;
  inspect(): Inspection;
  dispose(): void;
}

export type CreateRenderer = () => CanvasRenderer;
