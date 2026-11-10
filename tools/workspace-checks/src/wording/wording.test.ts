import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { bannedWords, readableText, sourceFiles } from './scan.js';

/**
 * A person reads "relationship", never "edge". The web is scanned for every text a person can read; the server and the contract are scanned for every sentence a person can be shown (an error message,
 * a warning, a description): a text of more than one word, because a single token is a code or a name. The allow-list holds the sentences that are not shown to a person, each with the reason.
 */
const WEB = join(repoRoot, 'apps', 'web', 'src');
const SERVER = [join(repoRoot, 'services', 'api', 'src'), join(repoRoot, 'packages', 'contracts', 'src')];

/** Server sentences that say "edge" and are not shown to a person; keyed by `file: sentence`. */
const NOT_SHOWN: Readonly<Record<string, string>> = {};

describe('the words a person reads in the web', () => {
  const files = sourceFiles(WEB);

  it('scans the whole web source and finds a good deal of text', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((file) => readableText(file, WEB)).length).toBeGreaterThan(1000);
  });

  it('says relationship, never edge, in any text a person can read', () => {
    expect(files.flatMap((file) => bannedWords(file, WEB))).toEqual([]);
  });
});

describe('the sentences a person is shown by the server and the contract', () => {
  const roots = SERVER.map((root) => ({ root, files: sourceFiles(root) }));

  it('scans the server and the contract and finds a good deal of text', () => {
    expect(roots.flatMap(({ files }) => files).length).toBeGreaterThan(150);
    expect(roots.flatMap(({ root, files }) => files.flatMap((file) => readableText(file, root, undefined, true))).length).toBeGreaterThan(300);
  });

  it('says relationship, never edge, in any sentence that is shown, except the ones listed as not shown', () => {
    const found = roots.flatMap(({ root, files }) => files.flatMap((file) => bannedWords(file, root, undefined, true)));
    expect(found.filter((entry) => !Object.keys(NOT_SHOWN).includes(entry))).toEqual([]);
  });

  it('lists only sentences that are still there, each with a reason', () => {
    const found = roots.flatMap(({ root, files }) => files.flatMap((file) => bannedWords(file, root, undefined, true)));
    for (const [entry, reason] of Object.entries(NOT_SHOWN)) {
      expect(found, entry).toContain(entry);
      expect(reason.length, entry).toBeGreaterThan(10);
    }
  });
});

describe('the scan sees what it is for', () => {
  const probe = (source: string, prose = false) => bannedWords('probe.tsx', '.', source, prose).map((entry) => entry.split(': ')[1]);

  it('sees the word in a string, in a template, in JSX text and in a visible prop, and skips code', () => {
    const source = [
      "export const a = 'No edges here';",
      'export const b = (n: number) => `${n} edge`;',
      'export const c = () => <p>An edge</p>;',
      'export const d = () => <button aria-label="Open the edge" data-kind="edge">x</button>;',
      "import x from 'edge';",
      "export const e = { selector: 'edge[origin = \"derived\"]' };",
      "export const f = () => { throw new Error('a stored edge is needed'); };",
      "export const g = (k: string) => k === 'edge';",
      "export const h = { group: 'edges', path: '/v1/edges/', selector: 'node, edge' };",
      "export const i = () => ['An edge'].join(' ');",
      "export const j = (x: string[]) => x.map(() => 'The edge');",
      "export const k = (k: string) => { switch (k) { case 'a': return 'Edge case'; default: return 'x'; } };",
    ].join('\n');
    expect(probe(source)).toEqual(['No edges here', 'edge', 'An edge', 'Open the edge', 'An edge', 'The edge', 'Edge case']);
  });

  it('on the server sees a sentence and not a single token', () => {
    expect(probe("export const a = '1 derived edge was left out'; export const b = 'edge'; export const c = 'edge-load'; export const d = 'edge.load';", true)).toEqual(['1 derived edge was left out']);
  });

  it('on the server sees a sentence that is put together, whose word stands alone in a piece', () => {
    const source = [
      "export const a = (n: number) => `${n} ${n === 1 ? 'edge' : 'edges'} were left out`;",
      "export const b = (n: number) => n + ' edges were left out';",
      "export const c = (n: number) => 'left out: ' + (n === 1 ? 'edge' : 'relationship');",
    ].join('\n');
    expect(probe(source, true)).toEqual(['edge', 'edges', 'edges were left out', 'edge']);
  });
});
