import { ASK_PLAN_PARAM_NAMES, ASK_PLAN_TEMPLATE_IDS, type AiMappingView } from '@neburyx/contracts';

export interface VocabularyInput {
  /** The mapping the extension was configured with; the names of its entity and relationship types count, never a property name. */
  readonly view: AiMappingView | undefined;
  /** Further catalog words, as the planner's catalog text supplies them. */
  readonly catalogWords?: readonly string[];
}

/** The identifiers of the templates a plan names and the parameter names of their plan schemas: the words of the catalog that the contract itself holds. */
function contractCatalogEntries(): readonly string[] {
  return [...ASK_PLAN_TEMPLATE_IDS, ...ASK_PLAN_PARAM_NAMES];
}

/**
 * The entries the rebuild reads as vocabulary: type names of the mapping, template identifiers and parameter names of the plan
 * contract, and the catalog words a caller adds. Each entry is split into words by the rebuild's own rule.
 */
export function questionVocabulary(input: VocabularyInput): readonly string[] {
  const typeNames = (input.view?.types ?? []).map((type) => type.name);
  return [...new Set([...typeNames, ...contractCatalogEntries(), ...(input.catalogWords ?? [])])];
}
