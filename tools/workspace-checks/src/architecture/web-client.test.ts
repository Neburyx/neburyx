import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkCommunityImports } from './community.js';
import { checkWebClient, checkWebDependencies, contractsExports, formatWebViolations, readWebPackageJson } from './web-client.js';
import { loadTree, type SourceFile } from './tree.js';

const CONTRACTS = new Set(['MeResponse', 'SourceSummary']);

function check(path: string, text: string) {
  const file: SourceFile = { path, text };
  return checkWebClient([file], CONTRACTS);
}

describe('the renderer import', () => {
  it.each([
    ["import cytoscape from 'cytoscape';", 'apps/web/src/Panel.tsx'],
    ["import cytoscape from 'cytoscape';", 'apps/web/src/canvas/graph-canvas.tsx'],
    ["import { x } from 'cytoscape/dist/cytoscape.esm.mjs';", 'apps/web/src/canvas/helpers.ts'],
    ["export { default } from 'cytoscape';", 'apps/web/src/canvas/index.ts'],
    ["const cy = await import('cytoscape');", 'apps/web/src/canvas/lazy.ts'],
    ["const cy = require('cytoscape');", 'apps/web/src/a.ts'],
    ["type Cy = import('cytoscape').Core;", 'apps/web/src/canvas/types.ts'],
    ["import cy = require('cytoscape');", 'apps/web/src/canvas/legacy.ts'],
    ["import cytoscape from 'cytoscape';", 'apps/web/src/canvas/cytoscape-renderer.test.ts'],
  ])('is reported outside the adapter module: %s in %s', (text, path) => {
    expect(check(path, text)).toMatchObject([{ rule: 'web-renderer-import', file: path }]);
  });

  it('is allowed in the adapter module, and a name that only starts like it is not reported', () => {
    expect(check('apps/web/src/canvas/cytoscape-renderer.ts', "import cytoscape from 'cytoscape';")).toEqual([]);
    expect(check('apps/web/src/a.ts', "import x from 'cytoscape-like'; import y from './cytoscape.js';")).toEqual([]);
  });
});

describe('a web client file that imports from ee/', () => {
  it('is reported, in a .tsx file too', () => {
    const file: SourceFile = { path: 'apps/web/src/Panel.tsx', text: "import { x } from '../../../ee/policy/index.js';\nexport const y = x;" };
    expect(checkCommunityImports([file])).toMatchObject([{ rule: 'community-imports-ee', file: 'apps/web/src/Panel.tsx' }]);
  });
});

describe('fetch of the API', () => {
  it.each([
    ["fetch('/v1/me');", 'apps/web/src/Panel.tsx'],
    ['fetch(`/v1/sources/${id}/profile`);', 'apps/web/src/pages/Sources.tsx'],
    ["window.fetch('/v1/me');", 'apps/web/src/a.ts'],
  ])('is reported outside the API client folder: %s', (text, path) => {
    expect(check(path, text)).toMatchObject([{ rule: 'web-fetch', file: path }]);
  });

  it('is allowed inside the API client folder, and a fetch of something else is not reported', () => {
    expect(check('apps/web/src/api/client.ts', "fetch('/v1/me');")).toEqual([]);
    expect(check('apps/web/src/a.ts', "fetch('/healthz'); fetch('/v10/x');")).toEqual([]);
  });

  it('is not checked in a test file', () => {
    expect(check('apps/web/src/a.test.ts', "fetch('/v1/me');")).toEqual([]);
  });
});

describe('a hand-written type for an API shape', () => {
  it.each([
    ['export interface MeResponse { readonly id: string }', 'apps/web/src/api/client.ts'],
    ['export type SourceSummary = { readonly id: string };', 'apps/web/src/pages/a.tsx'],
    ['export interface SourcesResponse { items: string[] }', 'apps/web/src/Sources.tsx'],
    ['type ProfileBody = { id: string } & { name: string };', 'apps/web/src/api/client.ts'],
    ['export type SaveDto = { id: string };', 'apps/web/src/a.ts'],
  ])('is reported: %s', (text, path) => {
    expect(check(path, text)).toMatchObject([{ rule: 'web-wire-type', file: path }]);
  });

  it.each([
    ["import type { MeResponse } from '@neburyx/contracts';", 'apps/web/src/a.ts'],
    ["import { z } from 'zod'; export type Shape = z.infer<typeof schema>;", 'apps/web/src/a.ts'],
    ['export type MeResponse = z.infer<typeof meResponseSchema>;', 'apps/web/src/a.ts'],
    ['export interface Fetcher { (input: string): Promise<unknown> }', 'apps/web/src/api/client.ts'],
    ['export interface ClientFailure { readonly code: string }', 'apps/web/src/api/client.ts'],
    ['export type RequestState<T> = { readonly phase: "idle" } | { readonly phase: "ready"; readonly data: T };', 'apps/web/src/api/use-request.ts'],
    ['interface PanelProps { readonly title: string }', 'apps/web/src/Panel.tsx'],
  ])('is not reported for a client-only type or a contract-derived one: %s', (text, path) => {
    expect(check(path, text)).toEqual([]);
  });
});

describe('query text in the web client', () => {
  it.each([
    ["const q = 'RETURN 1';", 'string'],
    ["const q = 'CREATE (n)';", 'string'],
    ["const q = 'MATCH p=(a)-->(b) RETURN p';", 'string'],
    ["const q = 'CALL db.labels()';", 'string'],
    ['const q = `MATCH (n:${label}) RETURN n`;', 'template'],
    ["const q = 'OPTIONAL MATCH (a)';", 'string'],
    ["const q = 'LOAD CSV FROM x';", 'string'],
  ])('is reported: %s', (text) => {
    const found = check('apps/web/src/a.ts', text);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((violation) => violation.rule === 'web-query-text')).toBe(true);
  });

  it('is reported in the text of a component', () => {
    expect(check('apps/web/src/Panel.tsx', 'export const p = <p>MATCH (n) RETURN n</p>;')).toMatchObject([{ rule: 'web-query-text' }]);
  });

  it.each(["const t = 'Return to Home';", "const t = 'Create an investigation';", "const t = 'Match found';", "const t = 'SET';"])('is not reported for plain copy: %s', (text) => {
    expect(check('apps/web/src/a.ts', text)).toEqual([]);
  });
});

describe('the web client dependencies', () => {
  it.each(['neo4j-driver', '@neo4j/graphql', 'pg', 'kysely', 'redis'])('a dependency on %s is reported', (name) => {
    expect(checkWebDependencies(JSON.stringify({ dependencies: { [name]: '1.0.0' } }))).toMatchObject([{ rule: 'web-database-dependency' }]);
  });

  it('is not reported for the packages the client uses', () => {
    expect(checkWebDependencies(JSON.stringify({ dependencies: { react: '1', zod: '4', '@neburyx/contracts': 'workspace:*' } }))).toEqual([]);
  });
});

describe('the contracts exports', () => {
  it('are read from the entry file, value and type exports alike', () => {
    expect(contractsExports("export { a, b as c } from './x.js';\nexport type { D } from './y.js';")).toEqual(new Set(['a', 'c', 'D']));
  });
});

describe('the real web client', () => {
  it('passes every check', () => {
    const files = loadTree(repoRoot, { include: ['apps/web/src'] });
    const contracts = contractsExports(readFileSync(join(repoRoot, 'packages/contracts/src/index.ts'), 'utf8'));
    expect(contracts.has('meResponseSchema')).toBe(true);
    const violations = [...checkWebClient(files, contracts), ...checkWebDependencies(readWebPackageJson(repoRoot))];
    expect(formatWebViolations(violations)).toBe('');
    expect(checkCommunityImports(files)).toEqual([]);
  });
});
