import type { GraphNode } from '@neburyx/contracts';
import { titleHoldsId } from './id-in-title.js';
import { RUN_COPY } from './run-copy.js';

export interface EntityLabel {
  readonly title: string;
  /** The ID to draw beside the title, only when it may be shown and the title does not already carry it. */
  readonly id: string | undefined;
  /** The title is the ID itself, because the entity has no title: drawn in the mono face. */
  readonly titleIsId: boolean;
}

/** What a person reads for an entity: its title once, and its ID only where the title does not already hold it and masking allows it. An entity with no title is read by its ID, or by a plain word while the ID is hidden. */
export function entityLabel(node: GraphNode, showIds: boolean): EntityLabel {
  const title = node.display.title.trim();
  const id = showIds && node.ref.stableId !== '' ? node.ref.stableId : undefined;
  if (title === '') return id === undefined ? { title: RUN_COPY.hiddenEntity, id: undefined, titleIsId: false } : { title: id, id: undefined, titleIsId: true };
  return { title, id: id !== undefined && titleHoldsId(title, id) ? undefined : id, titleIsId: false };
}
