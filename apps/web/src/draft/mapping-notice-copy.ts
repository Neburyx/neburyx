import type { DroppedFilterReason } from '@neburyx/contracts';

export const MAPPING_CHANGED_BANNER_ID = 'mapping-changed';
export const MAPPING_CHANGED_CHIP = 'Mapping changed';
export const MAPPING_CHANGED_HEADLINE = 'The mapping changed since this view was saved.';
export const NOTHING_HAD_TO_CHANGE = 'Nothing in this view had to change.';
export const NEWLY_SENSITIVE = 'Some fields are newly sensitive and are shown masked.';
export const UNMAPPED_ITEMS_SENTENCE = 'Items that are no longer mapped show as “No longer mapped”.';

const REASONS: Readonly<Record<DroppedFilterReason, string>> = {
  'property-removed': 'property removed',
  'not-filterable': 'no longer a filterable property',
  'now-personal': 'now a sensitive field',
};

export const droppedFilterText = (name: string, reason: DroppedFilterReason): string => `${name} (${REASONS[reason]})`;
export const FILTERS_STILL_HIDE = 'The filters saved with this view still hide some types.';

export function joined(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1] ?? ''}`;
}
