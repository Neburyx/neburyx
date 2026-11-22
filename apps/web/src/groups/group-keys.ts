const CARD_PREFIX = 'group:';
const MERGED_PREFIX = 'group-link:';

/** The key the scene gives the card of a collapsed group; no entity or relationship key starts with it. */
export const cardKey = (groupId: string): string => `${CARD_PREFIX}${groupId}`;
export const mergedKey = (parts: readonly string[]): string => `${MERGED_PREFIX}${JSON.stringify(parts)}`;

/** The id of the group a card key names; undefined for any other key. */
export const groupIdOfCard = (key: string): string | undefined => (key.startsWith(CARD_PREFIX) ? key.slice(CARD_PREFIX.length) : undefined);
