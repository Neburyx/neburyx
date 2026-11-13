import { ASK_PLAN_TEMPLATE_IDS, askPlanParamsJsonSchema } from '@neburyx/contracts';

type TemplateId = (typeof ASK_PLAN_TEMPLATE_IDS)[number];

export interface CatalogEntry {
  readonly id: TemplateId;
  readonly version: number;
  readonly description: string;
  readonly paramsSchema: Record<string, unknown>;
}

const TEMPLATE_VERSION = 1;

/**
 * What each template does and when a question calls for it, in words that name no entity, relationship or rule of any source: those come from the vocabulary of the mapping. The rules the question sets need are here, in neutral form.
 */
const DESCRIPTIONS: Readonly<Record<TemplateId, string>> = {
  'shared-attribute':
    'Finds the other records that share an attribute record with the anchor. Give the anchor, the type of the attribute record and the one relationship type that joins the anchor to it. Use it for the plain question of who or what shares the same attribute. A question that asks for the chain that shows the link between two records is not this template: use derived-rule-run. The optional window keeps recent relationships and minShared asks for more than one shared attribute record.',
  'linked-entities':
    'Finds the entities of a target type that are linked to the anchor through the listed relationship types, in one or two hops (maxHops). When the question names only the two ends and one relationship type joins them directly, list that one relationship type with maxHops 1. When the question names the entity type that a path goes through, list every relationship type of the path in via and set maxHops to 2. State the direction (out, in or both) whenever the question says which way a relationship goes. A question about a shared attribute is not this template: use shared-attribute.',
  entity: 'Reads the one entity the anchor names. Use it when the question asks what an entity is or for its details.',
  'degree-preview': 'Counts the relationships of the anchor by relationship type and direction, without reading them. Use it when the question asks how connected an entity is.',
  expand:
    'Lists the neighbors of the anchor that are of the listed neighbor types, optionally only through the listed relationship types. Always state the direction (out, in or both), and add a window when the question limits it to recent relationships and a limit when it asks for a number. Use it when the question asks which entities are directly connected to the anchor.',
  'derived-rule-run': 'Runs one derived rule of the vocabulary from the anchor and shows the chain of relationships that makes the link. Use it when the question asks how or why entities are linked, or asks for the chain that shows the link.',
  'derived-edge-support': 'Shows the stored relationships that support the link of one derived rule between two named entities. Use it when the question names two entities and a derived rule and asks what supports the link.',
  search: 'Looks for entities of the listed types that hold a typed value in a searchable property. Use it for a value that is not an entity, such as a reference the question quotes as a value placeholder.',
};

export const CATALOG: readonly CatalogEntry[] = ASK_PLAN_TEMPLATE_IDS.map((id) => ({ id, version: TEMPLATE_VERSION, description: DESCRIPTIONS[id], paramsSchema: askPlanParamsJsonSchema(id) }));

/** The catalog as the prompt carries it: one block for each template, with its identifier, version, description and parameter schema. */
export function catalogText(entries: readonly CatalogEntry[] = CATALOG): string {
  return entries.map((entry) => `${entry.id} (version ${entry.version})\n${entry.description}\nParameters: ${JSON.stringify(entry.paramsSchema)}`).join('\n\n');
}

/** Every word of the catalog descriptions, for the vocabulary the allowlist reads. */
export function catalogWords(entries: readonly CatalogEntry[] = CATALOG): readonly string[] {
  return [...new Set(entries.flatMap((entry) => entry.description.split(/[^A-Za-z0-9-]+/)).filter((word) => word !== ''))];
}
