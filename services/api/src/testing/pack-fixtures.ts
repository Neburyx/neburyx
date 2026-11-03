import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMapping } from '../mapping/load.js';
import type { SourceModel } from '../mapping/model.js';

export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
export const FIXTURES_DIR = join(repoRoot, 'tools', 'demo-graph', 'fixtures', 'normalization');

export const PACKS = ['banking-fraud', 'insurance-claims'] as const;
export type Pack = (typeof PACKS)[number];

/** The source of a pack, from its mapping file; `uri` replaces the address the file names. */
export function packSource(pack: Pack, uri?: string): SourceModel {
  const text = readFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), 'utf8');
  const [source] = parseMapping(uri === undefined ? text : text.replace(/uri: "[^"]+"/, `uri: "${uri}"`), 'neburyx.yaml').sources;
  if (source === undefined) throw new Error(`the ${pack} pack has no source`);
  return source;
}

/** Each element ID of a container is its own, so a capture names them in the order they first appear. */
export function canonicalise<T>(value: T): T {
  const names = new Map<string, string>();
  const canonical = (id: string): string => {
    const known = names.get(id);
    if (known !== undefined) return known;
    const next = `eid-${names.size + 1}`;
    names.set(id, next);
    return next;
  };
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (typeof node === 'object' && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([key, entry]) => [key, (key === 'elementId' || key === 'startElementId' || key === 'endElementId') && typeof entry === 'string' ? canonical(entry) : walk(entry)]));
    }
    return node;
  };
  return walk(value) as T;
}

export type Fixture = Record<string, unknown>;

export function fixturePath(pack: Pack): string {
  return join(FIXTURES_DIR, `${pack}.json`);
}

export function readFixture(pack: Pack): Fixture {
  return JSON.parse(readFileSync(fixturePath(pack), 'utf8')) as Fixture;
}

/** With UPDATE_NORMALIZATION_FIXTURES=1 the capture is written; otherwise it is compared by the test. */
export function updating(): boolean {
  return process.env['UPDATE_NORMALIZATION_FIXTURES'] === '1';
}

export function writeFixture(pack: Pack, fixture: Fixture): void {
  if (!existsSync(FIXTURES_DIR)) mkdirSync(FIXTURES_DIR, { recursive: true });
  writeFileSync(fixturePath(pack), `${JSON.stringify(fixture, null, 2)}\n`);
}
