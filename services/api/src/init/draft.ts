import { SCHEMA_DRAFT_CAP } from '../gate/templates/schema-draft.js';
import type { Connection } from './bare-source.js';
import type { SourceSchema } from './schema-read.js';

export type Draft = { readonly ok: true; readonly text: string; readonly markers: number; readonly marker: string; readonly cut: readonly string[] } | { readonly ok: false; readonly message: string };

const CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

/** A name or a text as a YAML double-quoted scalar: JSON's escapes are YAML's, so a colon, a quote, a line break, `#` or a control character stays inside the value. */
function quoted(value: string): string {
  return JSON.stringify(value).replaceAll(CONTROL, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A name or a text inside a comment: a line break and every control character become a space, so it cannot end the comment line. */
function inComment(value: string): string {
  return value.replaceAll(CONTROL, ' ');
}

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const isEnvironmentName = (value: string): boolean => ENVIRONMENT_NAME.test(value);

/** The marker text: `TODO`, unless a name read from the database is the same text, because a marker must never resolve to a real name. */
function markerFor(schema: SourceSchema): string {
  const known = new Set([...schema.labels, ...schema.types, ...schema.propertyKeys]);
  let marker = 'TODO';
  while (known.has(marker)) marker += '_';
  return marker;
}

const SEARCHABLE = new Set(['RANGE', 'TEXT']);
/** The constraint types that name one node or relationship, as 5.26 and the 2026 series spell them. */
const KEYED = new Set(['UNIQUENESS', 'NODE_KEY', 'RELATIONSHIP_UNIQUENESS', 'RELATIONSHIP_KEY', 'NODE_PROPERTY_UNIQUENESS', 'RELATIONSHIP_PROPERTY_UNIQUENESS']);

function listing(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.map((value) => inComment(value)).join(', ');
}

/**
 * The draft mapping for one source, made from the schema alone: the file has the connection, one entity type for each label and one relationship type for each type,
 * with a marker where only the engineer can choose and a comment that lists what the schema says about the choice. No property value is an input, so none can be in the file.
 */
export function draftMapping(schema: SourceSchema, connection: Connection): Draft {
  if (schema.labels.length === 0) return { ok: false, message: 'The database has no labels to draft from: a mapping needs at least one entity type. Load data, or write the mapping by hand.' };
  const marker = markerFor(schema);
  // a property that the mapping's property rule refuses (it bans braces), so that when the key list was cut and a key named like the marker is out of sight, a marker left in still cannot name a real property
  const stableMarker = schema.propertyKeysCut ? `"{${marker}}"` : marker;
  const cut: string[] = [];
  if (schema.labelsCut) cut.push('labels');
  if (schema.typesCut) cut.push('relationship types');
  if (schema.propertyKeysCut) cut.push('property keys');
  if (schema.indexesCut) cut.push('indexes');
  if (schema.constraintsCut) cut.push('constraints');
  const lines: string[] = [
    '# A draft mapping made by `neburyx init` from the schema of the source: its labels, relationship types, property keys, indexes and constraints.',
    '# No property value was read, so none is in this file.',
    `# Replace every ${marker} (a choice only you can make), then check the file with: neburyx test-source --name ${inComment(connection.sourceId)}`,
  ];
  for (const kind of cut) lines.push(`# NOTE: the database has more than ${SCHEMA_DRAFT_CAP} ${kind}; the list of ${kind} below is partial.`);
  lines.push(
    'sources:',
    `  - id: ${quoted(connection.sourceId)}`,
    `    uri: ${quoted(connection.uri)}`,
    `    database: ${quoted(connection.database)}`,
    '    auth:',
    '      kind: basic',
    `      username_env: ${connection.usernameEnv}`,
    `      password_env: ${connection.passwordEnv}`,
    '    entities:',
    `      # ${marker}: keep the labels that are entity types and delete the others; rename a type if you want a different name in the app.`,
  );
  for (const label of schema.labels) {
    const keyed = schema.constraints.filter((constraint) => constraint.entityType === 'NODE' && KEYED.has(constraint.type) && constraint.labelsOrTypes.includes(label));
    const searched = schema.indexes.filter((index) => index.entityType === 'NODE' && SEARCHABLE.has(index.type) && index.labelsOrTypes.includes(label));
    lines.push(
      `      - type: ${quoted(label)}`,
      `        label: ${quoted(label)}`,
      `        # stable ID: the property that names one node. Properties on a uniqueness or key constraint of this label: ${listing(keyed.flatMap((constraint) => constraint.properties))}`,
      `        stable_id: ${stableMarker}`,
      `        # ${marker} search: a list of properties people search by. Properties on a range or text index of this label: ${listing(searched.flatMap((index) => index.properties))}`,
      `        # ${marker} pii: the properties that hold personal data`,
    );
  }
  if (schema.types.length > 0) {
    lines.push('    relationships:');
    for (const type of schema.types) lines.push(`      - type: ${quoted(type)}`, `        from: ${marker}`, `        to: ${marker}`);
  }
  lines.push('', '# Everything the schema reads returned:', `# Property keys (database-wide): ${listing(schema.propertyKeys)}`);
  lines.push('# Indexes:');
  for (const index of schema.indexes) lines.push(`#   ${inComment(index.name)}: ${inComment(index.type)} on ${index.entityType === 'NODE' ? 'label' : 'relationship type'} ${listing(index.labelsOrTypes)}, properties ${listing(index.properties)}, ${inComment(index.state)}`);
  if (schema.indexes.length === 0) lines.push('#   none');
  lines.push('# Constraints:');
  for (const constraint of schema.constraints) lines.push(`#   ${inComment(constraint.name)}: ${inComment(constraint.type)} on ${constraint.entityType === 'NODE' ? 'label' : 'relationship type'} ${listing(constraint.labelsOrTypes)}, properties ${listing(constraint.properties)}`);
  if (schema.constraints.length === 0) lines.push('#   none');
  const text = `${lines.join('\n')}\n`;
  const markers = 1 + 3 * schema.labels.length + 2 * schema.types.length;
  return { ok: true, text, markers, marker, cut };
}
