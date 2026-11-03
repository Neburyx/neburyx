import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repository } from './stack.js';

const example = readFileSync(join(repository, 'deploy/demo/.env.example'), 'utf8');
const composeText = [join(repository, 'deploy/demo/compose.yaml'), join(repository, 'deploy/compose/compose.yaml')].map((file) => readFileSync(file, 'utf8')).join('\n');

const SECRET = /PASSWORD|KEY/;

const VARIABLE = /^(?:# )?([A-Z][A-Z0-9_]+)=(.*)$/;

function listed(): { readonly name: string; readonly value: string; readonly described: boolean }[] {
  const lines = example.split('\n');
  return lines.flatMap((line, index) => {
    const match = VARIABLE.exec(line);
    if (match?.[1] === undefined) return [];
    const above = lines[index - 1] ?? '';
    return [{ name: match[1], value: match[2] ?? '', described: above.startsWith('# ') && !VARIABLE.test(above) }];
  });
}

function used(): Set<string> {
  return new Set([...composeText.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]])));
}

describe('the demo settings example', () => {
  it('lists every variable the compose files use, and only those', () => {
    expect(new Set(listed().map((entry) => entry.name))).toEqual(used());
  });

  it('describes each variable in the comment line directly above it, and holds no value for a password or key', () => {
    const entries = listed();
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.described, entry.name).toBe(true);
      if (SECRET.test(entry.name)) expect(entry.value, entry.name).toBe('');
    }
  });
});
