import type { AskRefusalCause } from '@neburyx/contracts';
import type { ToolEntry } from '../workspace/tool-registry.js';

/** The id the Paths tool registers under, as an action tool; Ask offers it only then. */
export const PATHS_TOOL_ID = 'paths';

export type RefusalChip = 'paths' | 'filters' | 'search' | 'search-id' | 'expand';

export const CHIP_LABELS: Readonly<Record<RefusalChip, string>> = {
  paths: 'Open Paths',
  filters: 'Open Filters',
  search: 'Search',
  'search-id': 'Search by stable ID',
  expand: 'Expand',
};

/** Asked of the card, a family that has Expand shows its own line, which does not depend on the canvas hint. */
export const EXPAND_HINT = 'To expand an entity, select it and press E, or right-click it.';

/** True for the one tool a chip may run: an action tool with the Paths id. A tool that opens a flyout is not offered. */
export const isPathsTool = (tool: ToolEntry | undefined): boolean => tool !== undefined && tool.id === PATHS_TOOL_ID && tool.kind.type === 'action';

/** What the card offers for a cause, in order. Every cause gets the same chips until the Ask panel is rebuilt and chooses them by cause. */
export function chipsOf(_cause: AskRefusalCause): readonly RefusalChip[] {
  return ['search-id', 'filters', 'expand'];
}
