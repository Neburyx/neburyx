import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll } from 'vitest';

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

export function makeRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'domain-words-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

export function packText(entities: readonly (readonly [string, string])[], relationships: readonly string[] = []): string {
  const lines = ['sources:', '  - id: demo', '    entities:'];
  for (const [type, label] of entities) lines.push(`      - { type: ${type}, label: ${label}, stable_id: id }`);
  if (relationships.length > 0) {
    lines.push('    relationships:');
    for (const type of relationships) lines.push(`      - { type: ${type}, from: ${entities[0]?.[0] ?? 'x'}, to: ${entities[0]?.[0] ?? 'x'} }`);
  }
  return `${lines.join('\n')}\n`;
}
