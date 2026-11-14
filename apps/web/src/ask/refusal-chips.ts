import type { AskRefusalCause } from '@neburyx/contracts';
import type { ToolEntry } from '../workspace/tool-registry.js';

/** The id the Paths tool registers under, as an action tool; Ask offers it only then. */
const PATHS_TOOL_ID = 'paths';

export type RefusalChip = 'paths' | 'filters' | 'search-id' | 'expand';

export const CHIP_LABELS: Readonly<Record<RefusalChip, string>> = {
  paths: 'Open Paths',
  filters: 'Open Filters',
  'search-id': 'Search by stable ID',
  expand: 'Expand',
};

/** Shown for the Expand chip, which has no tool of its own: Expand is a gesture on a selected entity. */
export const EXPAND_HINT = 'To expand an entity, select it and press E, or right-click it.';

/** True for the one tool a chip may run: an action tool with the Paths id. A tool that opens a flyout is not offered. */
export const isPathsTool = (tool: ToolEntry | undefined): boolean => tool !== undefined && tool.id === PATHS_TOOL_ID && tool.kind.type === 'action';

/** What the card offers, in order; Paths only when its tool is registered as an action. Every manual tool works without Ask, so no cause removes one. */
export function chipsOf(_cause: AskRefusalCause, pathsRegistered: boolean): readonly RefusalChip[] {
  return [...(pathsRegistered ? (['paths'] as const) : []), 'filters', 'search-id', 'expand'];
}
