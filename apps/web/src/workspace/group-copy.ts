export const GROUP_PANEL_COPY = {
  title: 'Group loaded nodes',
  close: 'Close Group',
  intro: 'Rearranges what is loaded. Nothing new is fetched.',
  groupBy: 'Group by',
  entityType: 'Entity type',
  property: 'Property',
  component: 'Component',
  footnote: 'Counts are loaded items, not source totals. Groups are saved with the view.',
  ungroupAll: 'Ungroup all',
  collapseAll: 'Collapse all',
  noGroups: 'No groups yet. Choose how to group.',
  nothingLoaded: 'Nothing is loaded to group.',
  otherTypes: 'Other types',
  propertyLabel: 'Property to group by',
  mappingLoading: 'The mapping is still loading.',
  noPropertyValue: 'No loaded item has a value for this property.',
  noRelationships: 'No loaded relationship joins two loaded entities.',
  expandGroup: (name: string): string => `Expand ${name}`,
  collapseGroup: (name: string): string => `Collapse ${name}`,
  expandOther: 'Show the other types',
  collapseOther: 'Hide the other types',
} as const;

export const groupsHeading = (loaded: number): string => `GROUPS · ${loaded} LOADED ITEMS`;
export const loadedText = (count: number): string => `${count} loaded`;
export const leftOutValue = (count: number): string => `${count} loaded ${count === 1 ? 'item has' : 'items have'} no value.`;
export const leftOutRelationship = (count: number): string => `${count} loaded ${count === 1 ? 'item has' : 'items have'} no relationship.`;
export const MASKED_GROUPING_REMOVED = 'Grouping by a masked property was removed.';
export const PROFILE_GROUPING_REMOVED = 'Grouping by a property was removed: the mapping could not be read.';
export const VALUES_CHANGED_REMOVED = 'Grouping by a property whose values changed was removed.';

export const GROUP_ALL_BY_TYPE = 'Group all by type';
export const UNGROUP_ALL = 'Ungroup all';
export const ALL_ENTITY_TYPES = 'All entity types';
export const GROUP_BY_TYPE = 'Group by type';
export const GROUP_SELECTION = 'Group';
