import type { MappingSource } from './mapping.js';

export class SchemaError extends Error {}

export function quote(name: string): string {
  if (name.includes('`') || name === '') throw new SchemaError('a label, type or property name cannot be quoted safely');
  return `\`${name}\``;
}

export function schemaStatements(source: MappingSource): string[] {
  const statements: string[] = [];
  for (const entity of source.entities) {
    statements.push(`CREATE CONSTRAINT IF NOT EXISTS FOR (n:${quote(entity.label)}) REQUIRE n.${quote(entity.stableId)} IS UNIQUE`);
    for (const property of new Set([...entity.searchable, ...entity.reference])) {
      if (property !== entity.stableId) statements.push(`CREATE INDEX IF NOT EXISTS FOR (n:${quote(entity.label)}) ON (n.${quote(property)})`);
    }
  }
  for (const relationship of source.relationships) {
    const properties = new Set([...(relationship.stableId === undefined ? [] : [relationship.stableId]), ...relationship.evidence, ...(relationship.observedAt === undefined ? [] : [relationship.observedAt])]);
    for (const property of properties) statements.push(`CREATE INDEX IF NOT EXISTS FOR ()-[r:${quote(relationship.type)}]-() ON (r.${quote(property)})`);
  }
  return statements;
}
