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
  timeWindow: 'Time window',
  anyTime: 'Any time',
  appliesToLoaded: 'Applies to loaded items.',
  resetTimeWindow: 'Reset time window',
  noTimedRelationships: 'No relationship type in the mapping has a time',
} as const;

export const selectedRelationshipTypesText = (selected: number, all: number): string => {
  const noun = (count: number): string => (count === 1 ? 'relationship type' : 'relationship types');
  return selected === all ? `All ${all} ${noun(all)}` : `${selected} ${noun(selected)} selected`;
};

export const timeWindowUndatedText = (count: number): string => `${count} ${count === 1 ? 'relationship has' : 'relationships have'} no time and ${count === 1 ? 'stays' : 'stay'} shown`;

export const PROPERTY_FILTER_COPY = {
  suffix: 'property filter',
  personalSuffix: 'personal data, not saved',
  any: 'Any',
  noValues: 'No values to filter on yet',
  find: 'Find a value',
  notLoaded: 'not loaded',
  footnote: 'Property filters apply to loaded items only.',
  tooMany: (limit: number): string => `Up to ${limit} values can be chosen.`,
  unjudged: (count: number): string => `${count} ${count === 1 ? 'relationship carries' : 'relationships carry'} no properties to judge and ${count === 1 ? 'stays' : 'stay'} shown`,
  unusable: (count: number): string => `${count} ${count === 1 ? 'value cannot' : 'values cannot'} be chosen: ${count === 1 ? 'it is' : 'they are'} empty, too long or not storable`,
  noValueFor: (count: number, property: string): string => `${count} ${count === 1 ? 'has' : 'have'} no value for ${property}`,
} as const;

const RANGE_EXAMPLES = { number: '1000 or 999.5', date: '2026-03-01', dateTime: '2026-03-01T10:00:00Z', localDateTime: '2026-03-01T10:00:00', time: '10:00:00Z', localTime: '10:00:00' } as const;

export const PROPERTY_RANGE_COPY = {
  from: 'From',
  to: 'To',
  lowest: (text: string): string => `Lowest loaded: ${text}`,
  highest: (text: string): string => `Highest loaded: ${text}`,
  unreadable: (kind: keyof typeof RANGE_EXAMPLES): string => `Write it like ${RANGE_EXAMPLES[kind]}`,
  fromAfterTo: 'From is later than to',
  atLeast: (text: string): string => `≥ ${text}`,
  atMost: (text: string): string => `≤ ${text}`,
} as const;
