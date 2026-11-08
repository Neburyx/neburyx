export const LAYOUTS = [
  { id: 'force', label: 'Force' },
  { id: 'hierarchical', label: 'Hierarchical' },
  { id: 'radial', label: 'Radial' },
  { id: 'grid', label: 'Grid' },
] as const;

export type LayoutId = (typeof LAYOUTS)[number]['id'];

export const LAYOUT_DIRECTIONS = [
  { id: 'down', label: 'Top to bottom' },
  { id: 'right', label: 'Left to right' },
] as const;

export type LayoutDirection = (typeof LAYOUT_DIRECTIONS)[number]['id'];

export const DEFAULT_LAYOUT: LayoutId = 'force';
export const DEFAULT_DIRECTION: LayoutDirection = 'down';

export const layoutLabel = (id: LayoutId): string => LAYOUTS.find((layout) => layout.id === id)?.label ?? 'Force';
