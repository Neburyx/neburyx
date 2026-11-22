import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function productionFiles(folder: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'testing') continue;
      for (const [name, text] of productionFiles(path)) found.set(name, text);
    } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) found.set(relative(ROOT, path), readFileSync(path, 'utf8'));
  }
  return found;
}

const NODE_BUILDERS = new Set(['gate/normalize/node.ts', 'gate/redact/index.ts', 'gate/style-rules.ts']);
const CALLS_THE_REDACT_STAGE = new Set(['gate/gate.ts', 'gate/redact/index.ts']);

/**
 * What would let a node leave the gate without the style stage: the gate not styling what the redact stage returns (or holding a second redact call), a module outside the gate calling the redact stage itself, or a module outside the node
 * builders making a node's display, which is where the rule ids are put.
 */
function bypasses(files: ReadonlyMap<string, string>): string[] {
  const found: string[] = [];
  const gate = files.get('gate/gate.ts') ?? '';
  const calls = gate.split('deps.redact(').length - 1;
  if (calls !== 1) found.push(`gate/gate.ts calls the redact stage ${calls} times, not once`);
  if (!/styledItems\(\s*deps\.redact\(items, context\), context\s*\)/.test(gate)) found.push('gate/gate.ts does not style what the redact stage returns');
  for (const [name, text] of files) {
    if (!CALLS_THE_REDACT_STAGE.has(name) && /\b(redactItems|redactResult)\(/.test(text)) found.push(`${name} calls the redact stage outside the gate`);
    if (!NODE_BUILDERS.has(name) && /display:\s*\{\s*title\b/.test(text)) found.push(`${name} makes a node's display outside the node builders`);
  }
  return found;
}

describe('every node that leaves the gate is styled after the redact stage', () => {
  it('holds in the production source: one redact call, styled, no other caller, no other maker of a node display', () => {
    const files = productionFiles(ROOT);
    expect(files.has('gate/gate.ts')).toBe(true);
    expect(files.has('gate/normalize/node.ts')).toBe(true);
    expect(bypasses(files)).toEqual([]);
  });

  describe('the check fails for', () => {
    const sound = new Map([
      ['gate/gate.ts', 'const redacted = styledItems(deps.redact(items, context), context);'],
      ['gate/normalize/node.ts', 'return { display: { title, type } };'],
      ['graph/service.ts', 'const shown = nodes.map((node) => node.display.title);'],
    ]);

    it('a source that is as the production source is, so the canaries below differ from it by one change each', () => {
      expect(bypasses(sound)).toEqual([]);
    });

    it('a gate that does not style what the redact stage returns', () => {
      expect(bypasses(new Map([...sound, ['gate/gate.ts', 'const redacted = deps.redact(items, context);']]))).toContain('gate/gate.ts does not style what the redact stage returns');
    });

    it('a gate with a second redact call', () => {
      const twice = 'const a = styledItems(deps.redact(items, context), context); const b = deps.redact(more, context);';
      expect(bypasses(new Map([...sound, ['gate/gate.ts', twice]]))[0]).toContain('2 times');
    });

    it('a flow outside the gate that calls the redact stage itself', () => {
      expect(bypasses(new Map([...sound, ['graph/read-flow.ts', 'const nodes = redactItems(items, context);']]))).toEqual(['graph/read-flow.ts calls the redact stage outside the gate']);
    });

    it('a flow that builds the display of a node of its own', () => {
      expect(bypasses(new Map([...sound, ['graph/read-flow.ts', 'const node = { display: { title: id, type } };']]))).toEqual(["graph/read-flow.ts makes a node's display outside the node builders"]);
    });
  });
});
