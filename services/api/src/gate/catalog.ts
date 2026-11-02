import { z } from 'zod';
import { hasStrayMarkerCharacter, markersOf } from './render.js';
import { GATE_PARAMETERS, type Template, type TemplateCatalog } from './types.js';

export type TemplateDefinition = Omit<Template, 'integerParameters'>;

export class CatalogError extends Error {
  constructor(templateId: string, problem: string) {
    super(`the template ${templateId} ${problem}`);
    this.name = 'CatalogError';
  }
}

const RESERVED = 'limit';

const article = (kind: string): string => (kind === 'entity' ? 'an' : 'a');
/** The server-side page bound a paged template must carry, as in `LIMIT $limit + 1`. */
const PAGED_LIMIT = /LIMIT\s+\$limit\s*\+\s*1(?![\w$])/;

interface Shape {
  readonly properties: ReadonlyMap<string, string | undefined>;
}

function shapeOf(definition: TemplateDefinition): Shape {
  let json: z.core.JSONSchema.BaseSchema;
  try {
    json = z.toJSONSchema(definition.paramsSchema, { io: 'input', unrepresentable: 'any' });
  } catch {
    throw new CatalogError(definition.id, 'has a parameter schema that cannot be inspected');
  }
  if (json.type !== 'object' || json.additionalProperties !== false) throw new CatalogError(definition.id, 'has a parameter schema that is not a strict object');
  const properties = new Map<string, string | undefined>();
  for (const [name, property] of Object.entries(json.properties ?? {})) {
    const type = typeof property === 'object' && property !== null && 'type' in property && typeof property.type === 'string' ? property.type : undefined;
    properties.set(name, type);
  }
  return { properties };
}

/** A gate-filled parameter is declared exactly when the Cypher uses it, and a caller cannot also give it. */
function checkGateParameters(definition: TemplateDefinition, shape: Shape): void {
  const declared = definition.gateParameters ?? [];
  for (const name of GATE_PARAMETERS) {
    const used = new RegExp(`\\$${name}(?![\\w])`).test(definition.cypher);
    if (declared.includes(name) && !used) throw new CatalogError(definition.id, `declares the gate-filled parameter ${name} its Cypher never uses`);
    if (used && !declared.includes(name)) throw new CatalogError(definition.id, `uses the gate-filled parameter ${name} without declaring it`);
    if (declared.includes(name) && shape.properties.has(name)) throw new CatalogError(definition.id, `has the gate-filled parameter ${name} in its parameter schema`);
  }
}

function checkMarkers(definition: TemplateDefinition, shape: Shape): void {
  if (hasStrayMarkerCharacter(definition.cypher)) throw new CatalogError(definition.id, 'has Cypher with an @ that is not a marker');
  const used = markersOf(definition.cypher);
  for (const marker of used) {
    if (marker.kind === 'stableId' && !definition.entityParams.includes(marker.name)) throw new CatalogError(definition.id, 'has a stable id marker that no declared entity parameter backs');
  }
  const declared = [...definition.entityParams.map((name) => ({ kind: 'entity', name })), ...definition.relationshipParams.map((name) => ({ kind: 'relationship', name }))];
  for (const marker of used) {
    if (marker.kind === 'stableId') continue;
    if (!declared.some((entry) => entry.kind === marker.kind && entry.name === marker.name)) throw new CatalogError(definition.id, `has ${article(marker.kind)} ${marker.kind} marker it does not declare`);
  }
  for (const entry of declared) {
    if (!used.some((marker) => marker.kind === entry.kind && marker.name === entry.name)) throw new CatalogError(definition.id, `declares ${article(entry.kind)} ${entry.kind} marker its Cypher never uses`);
    if (!shape.properties.has(entry.name)) throw new CatalogError(definition.id, `declares a marker parameter its schema does not have`);
  }
}

function build(definition: TemplateDefinition): Template {
  const shape = shapeOf(definition);
  if (shape.properties.has(RESERVED)) throw new CatalogError(definition.id, 'declares the reserved parameter limit');
  if (definition.paged && !PAGED_LIMIT.test(definition.cypher)) throw new CatalogError(definition.id, 'is paged and its Cypher has no LIMIT $limit + 1');
  checkMarkers(definition, shape);
  checkGateParameters(definition, shape);
  const integerParameters = [...shape.properties].flatMap(([name, type]) => (type === 'integer' ? [name] : []));
  return { ...definition, integerParameters };
}

export interface CatalogOptions {
  readonly templates: readonly TemplateDefinition[];
  readonly isEnabled?: (templateId: string, sourceId: string) => boolean;
}

export function createTemplateCatalog(options: CatalogOptions): TemplateCatalog {
  const templates = new Map<string, Template>();
  for (const definition of options.templates) {
    if (templates.has(definition.id)) throw new CatalogError(definition.id, 'has an id that another template already uses');
    templates.set(definition.id, build(definition));
  }
  const enabled = options.isEnabled ?? (() => true);
  return {
    find: (templateId) => templates.get(templateId),
    isEnabled: (templateId, sourceId) => enabled(templateId, sourceId),
  };
}
