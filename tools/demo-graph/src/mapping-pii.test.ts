import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MappingError, readMappingSource } from './mapping.js';

const folder = mkdtempSync(join(tmpdir(), 'demo-mapping-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

function mappingWith(pii: string): string {
  const file = join(folder, `m-${Math.random().toString(16).slice(2)}.yaml`);
  writeFileSync(
    file,
    [
      'sources:',
      '  - id: demo',
      '    uri: "bolt://demo.example.test:7687"',
      '    database: neo4j',
      '    auth: { kind: basic, username_env: DEMO_USER, password_env: DEMO_PASSWORD }',
      '    entities:',
      '      - type: widget',
      '        label: Widget',
      '        stable_id: widgetId',
      `        pii: ${pii}`,
      '',
    ].join('\n'),
  );
  return file;
}

describe('the pii marks of a mapping', () => {
  it('are read as property names whether they are bare or carry a class', () => {
    const source = readMappingSource(mappingWith('[plainField, { property: classedField, class: name }]'));
    const [entity] = source.entities;
    expect(entity?.properties.has('plainField')).toBe(true);
    expect(entity?.properties.has('classedField')).toBe(true);
    expect(entity?.properties.has('name')).toBe(false);
  });

  it('are refused when an entry is neither a name nor a { property, class }', () => {
    expect(() => readMappingSource(mappingWith('[{ class: name }]'))).toThrow(MappingError);
    expect(() => readMappingSource(mappingWith('[4]'))).toThrow(MappingError);
  });
});
