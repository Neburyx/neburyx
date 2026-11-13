import { createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import type { TemplateCatalog } from './types.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { connectivityTemplate } from './templates/connectivity.js';
import { degreePreviewBoundedTemplate, degreePreviewCheapTemplate } from './templates/degree-preview.js';
import { degreeProbeTemplate } from './templates/degree-probe.js';
import { derivedEdgeSupportTemplate } from './templates/derived-edge-support.js';
import { derivedRuleRunTemplate } from './templates/derived-rule-run.js';
import { linkedEntitiesTemplate } from './templates/linked-entities.js';
import { linkedEntitiesCountTemplate } from './templates/linked-entities-count.js';
import { sharedAttributeTemplate } from './templates/shared-attribute.js';
import { sharedAttributeCountTemplate } from './templates/shared-attribute-count.js';
import { aggregateSampleTemplate, aggregateSummaryTemplate } from './templates/aggregate-evidence.js';
import { edgeLoadTemplate } from './templates/edge-load.js';
import { edgeLoadManyTemplate } from './templates/edge-load-many.js';
import { entityLoadTemplate } from './templates/entity-load.js';
import { entityLoadManyTemplate } from './templates/entity-load-many.js';
import { expandCountTemplate } from './templates/expand-count.js';
import { expandNeighborsTemplate } from './templates/expand-neighbors.js';
import { searchExactTemplate } from './templates/search-exact.js';
import { searchPrefixTemplate } from './templates/search-prefix.js';
import { searchEvidenceTemplate } from './templates/search-evidence.js';
import { searchFacetsTemplate } from './templates/search-facets.js';
import { searchRelatedTemplate } from './templates/search-related.js';
import { relatedContextTemplate } from './templates/related-context.js';
import { privilegesTemplate } from './templates/privileges.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import { schemaTokensTemplate } from './templates/schema-tokens.js';
import { stableIdDuplicatesTemplate } from './templates/stable-id-duplicates.js';

export function defaultCatalogTemplates(): readonly TemplateDefinition[] {
  return [connectivityTemplate, capabilitiesTemplate, privilegesTemplate, schemaTokensTemplate, schemaIndexesTemplate, stableIdDuplicatesTemplate, degreeProbeTemplate, degreePreviewBoundedTemplate, degreePreviewCheapTemplate, entityLoadTemplate, entityLoadManyTemplate, edgeLoadTemplate, edgeLoadManyTemplate, expandNeighborsTemplate, expandCountTemplate, searchExactTemplate, searchRelatedTemplate, searchEvidenceTemplate, searchFacetsTemplate, searchPrefixTemplate, relatedContextTemplate, derivedRuleRunTemplate, sharedAttributeTemplate, sharedAttributeCountTemplate, linkedEntitiesTemplate, linkedEntitiesCountTemplate, derivedEdgeSupportTemplate, aggregateSampleTemplate, aggregateSummaryTemplate];
}

export function defaultCatalog(): TemplateCatalog {
  return createTemplateCatalog({ templates: defaultCatalogTemplates() });
}
