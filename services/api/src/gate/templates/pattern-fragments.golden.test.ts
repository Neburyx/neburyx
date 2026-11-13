import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fragmentInputs, fragmentStatements } from '../../testing/pattern-fragment-inputs.js';
import { shapeAllowlist } from '../../testing/pattern-shapes.js';
import { quoteName } from '../render.js';

// compiling every shape is slow when the suites run together
vi.setConfig({ testTimeout: 60_000 });

const FILE = join(dirname(fileURLToPath(import.meta.url)), 'pattern-fragments.golden.json');
const COMMAND = 'UPDATE_PATTERN_FRAGMENTS=1 pnpm --filter @neburyx/api exec vitest run src/gate/templates/pattern-fragments.golden.test.ts';
const current = fragmentStatements();

if (process.env['UPDATE_PATTERN_FRAGMENTS'] === '1') writeFileSync(FILE, `${JSON.stringify(current, null, 2)}\n`);
const stored: Record<string, string> = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, string>) : {};

describe('the fragments of a pattern statement, each alone', () => {
  it.each(Object.keys(current))('is pinned for %s', (name) => {
    expect(current[name], `regenerate with: ${COMMAND}`).toBe(stored[name]);
  });

  it('has a golden for every input value and an input value for every golden', () => {
    expect(Object.keys(stored).sort(), `regenerate with: ${COMMAND}`).toEqual(fragmentInputs().map((input) => input.name).sort());
  });

  it('covers each input of the compiler: the three directions, the types, the groups, the types with no stable ID, the window, the 74 forms, the steps and the stop-list rules', () => {
    const names = fragmentInputs().map((input) => input.name);
    for (const prefix of ['direction/in', 'direction/both', 'types/', 'groups/both/', 'no-stable-id/', 'window/timed', 'window/mixed', 'steps/2', 'steps/4', 'stop-list/1', 'stop-list/2', 'stop-list/paths/']) expect(names.some((name) => name.startsWith(prefix)), prefix).toBe(true);
    expect(names.filter((name) => name.startsWith('condition/neighbor/'))).toHaveLength(37);
    expect(names.filter((name) => name.startsWith('condition/relationship/'))).toHaveLength(37);
  });

  it('holds a name only inside backticks, for each name kind: the label, a relationship type, a property of a node and a property of a relationship', () => {
    const text = Object.values(current).join('\n');
    const withoutNames = text.replaceAll(/`[^`]*`/g, '');
    for (const name of ['Maker', 'LINKS', 'makerId', 'region', 'lane', 'seenAt']) {
      expect(text, name).toContain(`\`${name}\``);
      expect(withoutNames, name).not.toContain(name);
    }
  });

  it('differs between two inputs: a change of an input value changes the statement', () => {
    expect(current['direction/in']).not.toBe(current['base']);
    expect(current['window/timed']).not.toBe(current['base']);
    expect(current['stop-list/2']).not.toBe(current['stop-list/1']);
    expect(current['groups/both/4|T1+U3|1']).not.toBe(current['groups/both/4|T2+U2|1']);
  });
});

describe('the quoting of a name in a fragment', () => {
  it('writes a mapped name that holds a space between backticks, and refuses a name that holds a backtick, a backslash or a control character', () => {
    expect(quoteName('Maker Shop')).toBe('`Maker Shop`');
    for (const name of ['a`b', 'a\\b', 'a\nb', 'a\u0000b']) expect(() => quoteName(name), JSON.stringify(name)).toThrow();
  });

  it('is applied to every name of the allowlist the fragments are compiled on', () => {
    const allowlist = shapeAllowlist(2);
    for (const label of allowlist.entityLabels.values()) expect(() => quoteName(label)).not.toThrow();
    for (const type of allowlist.relationshipTypes) expect(() => quoteName(type)).not.toThrow();
  });
});
