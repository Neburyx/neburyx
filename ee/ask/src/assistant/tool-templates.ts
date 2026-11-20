import { PATHS_HOPS_MAX, PATHS_RESULTS_MAX, type AskFolder, type AskIntent } from '@neburyx/contracts';

/** What a path search reads when a request cannot choose it: the hops and the results, under the limits of every source. */
const PATH_HOPS = Math.min(3, PATHS_HOPS_MAX);
const PATH_RESULTS = Math.min(10, PATHS_RESULTS_MAX);

const place = (entityType: string, stableId: string) => ({ entityType: `$${entityType}`, stableId: `$${stableId}` });

interface TemplateTool {
  readonly name: string;
  readonly template: string;
  readonly parameters: readonly string[];
  readonly settings: () => Readonly<Record<string, unknown>>;
}

/**
 * The catalog templates a request may name by their id. A parameter is text: an entity is its type and its stable id, and a list of the template holds one value; what a request cannot choose (the hops and the size
 * of a path search) is fixed here. The settings have the shape of an intent of the operator's folder, so a request is bound and checked by the same code.
 */
const TEMPLATE_TOOLS: readonly TemplateTool[] = [
  { name: 'entity', template: 'entity', parameters: ['entityType', 'stableId'], settings: () => ({ ref: place('entityType', 'stableId') }) },
  { name: 'degree-preview', template: 'degree-preview', parameters: ['entityType', 'stableId'], settings: () => ({ ref: place('entityType', 'stableId') }) },
  { name: 'expand', template: 'expand', parameters: ['entityType', 'stableId', 'neighborType'], settings: () => ({ ref: place('entityType', 'stableId'), neighborTypes: ['$neighborType'] }) },
  { name: 'shared-attribute', template: 'shared-attribute', parameters: ['entityType', 'stableId', 'attributeType', 'via'], settings: () => ({ ref: place('entityType', 'stableId'), attributeType: '$attributeType', via: '$via' }) },
  { name: 'linked-entities', template: 'linked-entities', parameters: ['entityType', 'stableId', 'targetType', 'via'], settings: () => ({ ref: place('entityType', 'stableId'), targetType: '$targetType', via: ['$via'] }) },
  { name: 'derived-rule-run', template: 'derived-rule-run', parameters: ['entityType', 'stableId', 'ruleId'], settings: () => ({ ref: place('entityType', 'stableId'), ruleId: '$ruleId' }) },
  { name: 'derived-edge-support', template: 'derived-edge-support', parameters: ['ruleId', 'fromType', 'fromId', 'toType', 'toId'], settings: () => ({ ruleId: '$ruleId', ends: [place('fromType', 'fromId'), place('toType', 'toId')] }) },
  { name: 'search', template: 'search', parameters: ['entityType', 'text'], settings: () => ({ entityTypes: ['$entityType'], text: '$text' }) },
  {
    name: 'shortest-paths',
    template: 'shortest-paths',
    parameters: ['fromType', 'fromId', 'toType', 'toId', 'relType'],
    settings: () => ({ ends: [place('fromType', 'fromId'), place('toType', 'toId')], relTypes: ['$relType'], maxHops: PATH_HOPS, limit: PATH_RESULTS }),
  },
];

/** The templates a request may name, each with the template it runs and the names of its values. */
export const TEMPLATE_TOOL_LIST: readonly { readonly name: string; readonly template: string; readonly parameters: readonly string[] }[] = TEMPLATE_TOOLS.map(({ name, template, parameters }) => ({ name, template, parameters }));

/** The intent a template tool runs as: an intent of the folder's own kind, so the binding, the gate, the audit and the summary are Ask's. Undefined for a name that is no template tool. */
function templateIntentOf(name: string): AskIntent | undefined {
  const found = TEMPLATE_TOOLS.find((tool) => tool.name === name);
  return found === undefined ? undefined : { name, parameters: found.parameters, kind: 'template', template: found.template, settings: found.settings() };
}

/** The folder with the catalog templates added under their ids: an intent of the operator's own folder is found first, so no file is shadowed. A source and its intents are the folder's. */
export function withTemplateTools(folder: AskFolder | undefined): AskFolder | undefined {
  if (folder === undefined) return undefined;
  return { sourceIds: folder.sourceIds, source: folder.source, intent: (sourceId, name) => folder.intent(sourceId, name) ?? (folder.source(sourceId) === undefined ? undefined : templateIntentOf(name)) };
}
