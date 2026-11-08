export const FILTERS_PANEL_COPY = {
  title: 'Filters',
  close: 'Close Filters',
  entityTypes: 'Entity types',
  loadingTypes: 'Loading types',
  noEntityTypes: 'No entity types in the mapping',
  reset: 'Reset',
  relationshipTypes: 'Relationship types',
  noRelationshipTypes: 'No relationship types in the mapping',
  nothingLoaded: 'Nothing loaded yet.',
} as const;

export const selectedRelationshipTypesText = (selected: number, all: number): string => {
  const noun = (count: number): string => (count === 1 ? 'relationship type' : 'relationship types');
  return selected === all ? `All ${all} ${noun(all)}` : `${selected} ${noun(selected)} selected`;
};
