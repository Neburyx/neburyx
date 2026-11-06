// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteObject } from 'react-router';
import { describe, expect, it } from 'vitest';
import { fakeClient } from './api/fake-client.js';
import { appRoutes } from './routes.js';
import { createClientState } from './state/client-state.js';

const UX = join(import.meta.dirname, '../../../tools/ux');
const DEVELOPMENT_PREFIX = 'dev/';

function pathsOf(routes: readonly RouteObject[], prefix: string): string[] {
  return routes.flatMap((route) => {
    const own = [prefix, route.path ?? ''].map((part) => part.replace(/^\/+|\/+$/g, '')).filter((part) => part !== '').join('/');
    return [...(route.index === true || route.path !== undefined ? [own] : []), ...pathsOf(route.children ?? [], own)];
  });
}

function listedRoutes(): string[] {
  const parsed: unknown = JSON.parse(readFileSync(join(UX, 'tests/support/product-pages.json'), 'utf8'));
  const pages = typeof parsed === 'object' && parsed !== null && 'pages' in parsed && Array.isArray(parsed.pages) ? parsed.pages : [];
  return pages.flatMap((item: unknown) => (typeof item === 'object' && item !== null && 'route' in item && typeof item.route === 'string' ? [item.route] : []));
}

describe('the check of the browser\'s default look', () => {
  it('lists a page for every product route, so a new route cannot ship without a visit; the development routes are left out on purpose', () => {
    const product = [...new Set(pathsOf(appRoutes(fakeClient(), createClientState()), ''))].filter((path) => !path.startsWith(DEVELOPMENT_PREFIX));
    expect(product.length).toBeGreaterThan(0);
    const listed = new Set(listedRoutes());
    const missing = product.filter((path) => !listed.has(path));
    expect(missing, `the product routes with no entry in tools/ux/tests/support/product-pages.json: ${missing.join(', ')}`).toEqual([]);
  });

  it('knows the routes it walks: the home page, the search page, the sources page, a deep link, Explore and the not-found page', () => {
    const product = pathsOf(appRoutes(fakeClient(), createClientState()), '');
    for (const expected of ['', 'search', 'sources', ':sourceId/entity/:entityType/:stableId', 'explore', 'explore/:investigationId', '*']) expect(product).toContain(expected);
  });

  it('tells a feature that adds a state with controls to an existing page to add it to the list in the same change', () => {
    expect(readFileSync(join(UX, 'README.md'), 'utf8')).toContain('adds it to the list in the same change');
  });
});
