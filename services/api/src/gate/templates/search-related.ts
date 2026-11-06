import { searchTemplate } from './search-template.js';

export const SEARCH_RELATED_ID = 'entity-related';

export const searchRelatedTemplate = searchTemplate({ id: SEARCH_RELATED_ID, auditAction: 'entity.search_related', properties: 'reference' });
