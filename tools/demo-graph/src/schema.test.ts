import { describe, expect, it } from 'vitest';
import { quote, schemaStatements, SchemaError } from './schema.js';
import { miniMapping } from './testing/fixture.js';

describe('the constraints and indexes a mapping needs', () => {
  const statements = schemaStatements(miniMapping);

  it('holds a unique constraint on the stable ID of each entity type and nothing else on that property', () => {
    expect(statements).toContain('CREATE CONSTRAINT IF NOT EXISTS FOR (n:`Widget`) REQUIRE n.`widgetId` IS UNIQUE');
    expect(statements).toContain('CREATE CONSTRAINT IF NOT EXISTS FOR (n:`Gadget`) REQUIRE n.`gadgetId` IS UNIQUE');
    expect(statements.filter((statement) => statement.includes('INDEX') && statement.includes('`widgetId`'))).toEqual([]);
  });

  it('holds an index on a search property that is not the stable ID, and none on the stable ID itself', () => {
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS FOR (n:`Widget`) ON (n.`colour`)');
    expect(statements.filter((statement) => statement.includes('INDEX') && statement.includes('(n.`widgetId`)'))).toEqual([]);
  });

  it('holds an index on each reference property and on the stable ID, evidence and observed-at properties of a relationship type', () => {
    expect(statements).toContain('CREATE INDEX IF NOT EXISTS FOR (n:`Gadget`) ON (n.`batch`)');
    expect(statements).toContain('CREATE CONSTRAINT IF NOT EXISTS FOR ()-[r:`HAS`]-() REQUIRE r.`linkId` IS UNIQUE');
    for (const property of ['source', 'seenAt']) expect(statements).toContain(`CREATE INDEX IF NOT EXISTS FOR ()-[r:\`HAS\`]-() ON (r.\`${property}\`)`);
    expect(statements.filter((statement) => statement.includes('`NEAR`'))).toEqual([]);
  });

  it('makes every statement idempotent and takes labels, types and properties only from the mapping', () => {
    expect(statements.every((statement) => statement.includes('IF NOT EXISTS'))).toBe(true);
  });

  it('refuses a name that cannot be quoted safely', () => {
    expect(() => quote('bad`name')).toThrow(SchemaError);
    expect(() => quote('')).toThrow(SchemaError);
  });
});
