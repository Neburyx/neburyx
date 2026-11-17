import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { baseSource, fileOf, type Json } from '../testing/mapping.js';
import { parseMapping } from './load.js';
import { reloadStep } from './reload.js';

const folder = mkdtempSync(join(tmpdir(), 'reload-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

let counter = 0;
function fileWith(text: string): string {
  counter += 1;
  const path = join(folder, `mapping-${counter}.yaml`);
  writeFileSync(path, text);
  return path;
}

const held = (...sources: Json[]) => parseMapping(fileOf(...sources), 'held.yaml');
const withEntities = (extra: Json[]) => baseSource({ entities: [...(baseSource()['entities'] as Json[]), ...extra] });

describe('the reload step', () => {
  it('applies a valid file that differs, and lists the sources added, changed and removed', () => {
    const before = held(baseSource(), baseSource({ id: 'second' }), baseSource({ id: 'third' }));
    const path = fileWith(fileOf(withEntities([{ type: 'node_c', label: 'NodeC', stable_id: 'ref' }]), baseSource({ id: 'second' }), baseSource({ id: 'fourth' })));
    const step = reloadStep({ path, held: before, extensionLoaded: false });
    expect(step).toMatchObject({ kind: 'applied', added: ['fourth'], changed: ['demo'], removed: ['third'] });
    if (step.kind !== 'applied') throw new Error('not applied');
    expect(step.mapping.sources.map((source) => source.id)).toEqual(['demo', 'second', 'fourth']);
  });

  it('applies a change of a budget', () => {
    const step = reloadStep({ path: fileWith(fileOf(baseSource({ budgets: { max_page: 20 } }))), held: held(baseSource()), extensionLoaded: false });
    expect(step).toMatchObject({ kind: 'applied', changed: ['demo'] });
  });

  it('finds a file that gives the same mapping unchanged, whatever its comments and the order of its keys', () => {
    const before = held(baseSource());
    const reordered = `# a note\n${stringify({ sources: [Object.fromEntries(Object.entries(baseSource()).reverse())] })}`;
    expect(reloadStep({ path: fileWith(reordered), held: before, extensionLoaded: false })).toEqual({ kind: 'unchanged' });
  });

  it.each([
    ['a syntax error', 'sources: [\n  - id: demo\n   bad: ['],
    ['a key the schema does not know', fileOf(baseSource({ nope: true }))],
    ['an unknown entity type in a relationship', fileOf(baseSource({ relationships: [{ type: 'LINKS', from: 'node_a', to: 'nothing' }] }))],
    ['a file over one MiB', `${fileOf(baseSource())}# ${'x'.repeat(1_048_577)}\n`],
  ])('refuses %s with the loader message and holds the mapping', (_name, text) => {
    const step = reloadStep({ path: fileWith(text), held: held(baseSource()), extensionLoaded: false });
    expect(step.kind).toBe('refused');
    if (step.kind !== 'refused') throw new Error('not refused');
    expect(step.message.length).toBeGreaterThan(0);
    for (const secret of ['graph.example.test', 'DEMO_USER', 'DEMO_PASSWORD']) expect(step.message).not.toContain(secret);
  });

  it('refuses a missing file', () => {
    expect(reloadStep({ path: join(folder, 'no-such-file.yaml'), held: held(baseSource()), extensionLoaded: false }).kind).toBe('refused');
  });

  it.each([
    ['the address', { uri: 'neo4j+s://other.example.test:7687' }, 'the address of source demo changed'],
    ['the database', { database: 'other' }, 'the database of source demo changed'],
    ['the names of the credentials', { auth: { kind: 'basic', username_env: 'OTHER_USER', password_env: 'DEMO_PASSWORD' } }, 'the names of the credentials of source demo changed'],
  ])('refuses a change of %s of a source the process holds, with the restart message and no value, even when another source changed too', (_name, change, message) => {
    const path = fileWith(fileOf(baseSource(change), baseSource({ id: 'second', budgets: { max_page: 20 } })));
    const step = reloadStep({ path, held: held(baseSource(), baseSource({ id: 'second' })), extensionLoaded: false });
    expect(step).toEqual({ kind: 'refused', message: `${message}: it applies after a restart` });
  });

  it('refuses a change of the ai section with the restart message', () => {
    const text = stringify({ ai: { preview: true }, sources: [baseSource()] });
    const step = reloadStep({ path: fileWith(text), held: held(baseSource()), extensionLoaded: false });
    expect(step).toEqual({ kind: 'refused', message: 'the ai section changed: it applies after a restart' });
  });

  it('refuses, with the enterprise extension loaded, a source added or removed or a budget changed, and applies the same edit without it', () => {
    const before = held(baseSource());
    for (const text of [fileOf(baseSource(), baseSource({ id: 'second' })), fileOf(), fileOf(baseSource({ budgets: { max_page: 20 } }))]) {
      const loaded = reloadStep({ path: fileWith(text), held: before, extensionLoaded: true });
      expect(loaded.kind).toBe('refused');
      expect(reloadStep({ path: fileWith(text), held: before, extensionLoaded: false }).kind).toBe('applied');
    }
    const entityOnly = fileWith(fileOf(withEntities([{ type: 'node_c', label: 'NodeC', stable_id: 'ref' }])));
    expect(reloadStep({ path: entityOnly, held: before, extensionLoaded: true }).kind).toBe('applied');
  });
});
