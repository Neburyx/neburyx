import { searchTemplate } from './search-template.js';

export { normalizeSearch, searchTargetSchema, targetsOf, targetsSchema, type SearchTarget } from './search-template.js';

export const SEARCH_EXACT_ID = 'entity-search';

export const searchExactTemplate = searchTemplate({ id: SEARCH_EXACT_ID, auditAction: 'entity.search', properties: 'search' });
