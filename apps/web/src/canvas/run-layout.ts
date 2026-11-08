import type { Position } from '../state/presentation-state.js';
import type { LayoutDirection, LayoutId } from '../state/layout-choice.js';
import { gridLayout } from './grid-layout.js';
import { hierarchicalLayout } from './hierarchical-layout.js';
import { layoutEntities, type LayoutInput } from './incremental-layout.js';
import { radialLayout } from './radial-layout.js';

export interface RunInput extends LayoutInput {
  readonly layout: LayoutId;
  readonly direction: LayoutDirection;
  /** The entities selected and shown, in selection order. */
  readonly selected: readonly string[];
}

const centreOf = (points: readonly Position[]): Position => (points.length === 0 ? { x: 0, y: 0 } : { x: points.reduce((sum, point) => sum + point.x, 0) / points.length, y: points.reduce((sum, point) => sum + point.y, 0) / points.length });

/** The positions of the unpinned entities for the chosen layout; pinned entities are never among them. */
export function runLayout(input: RunInput): Map<string, Position> {
  const { ids, positions, pinned } = input;
  const fixed = new Map(ids.flatMap((id) => {
    const position = positions.get(id);
    return pinned.has(id) && position !== undefined ? [[id, position] as const] : [];
  }));
  const free = ids.filter((id) => !fixed.has(id));
  if (free.length === 0) return new Map();
  const centre = centreOf(free.flatMap((id) => positions.get(id) ?? []));
  switch (input.layout) {
    case 'grid':
      return gridLayout({ free, fixed, centre });
    case 'hierarchical':
      return hierarchicalLayout({ ids, links: input.links, fixed, direction: input.direction, centre });
    case 'radial':
      return radialLayout({ ids, links: input.links, fixed, selected: input.selected, centre });
    default:
      return layoutEntities(input);
  }
}
