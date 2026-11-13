import { describe, expect, it } from 'vitest';
import { registeredRoutesOf } from '../app.js';
import { closedSetOf, routesOfClosedSet } from '../testing/fuzz-closed-set.js';
import { startFuzzRig } from '../testing/fuzz-rig.js';

const rig = await startFuzzRig();
const closed = await closedSetOf(rig);

/** Routes of the API that the closed set does not build, each with the reason. Every other route under /v1 must be requested by the builder of the closed set. */
export const NOT_IN_THE_CLOSED_SET: Readonly<Record<string, string>> = {
  'GET /v1/me': 'reads no source',
  'GET /v1/sources': 'reads no source: the registry',
  'GET /v1/sources/:id/profile': 'reads no source: the stored profile',
  'POST /v1/sources/:id/test': 'runs the source tester, which does not go through the gate templates',
  'POST /v1/graph/coverage': 'reads no source: it answers from the references it is given',
  'GET /v1/investigations': 'reads no source: the application database',
  'GET /v1/investigations/:id': 'reads no source: the application database',
  'PUT /v1/investigations/:id/draft': 'reads no source: the application database',
  'PUT /v1/investigations/:id': 'reads no source: the application database',
  'DELETE /v1/investigations/:id': 'reads no source: the application database',
  'POST /v1/investigations/:id/restore': 'reads no source: the application database',
  'POST /v1/investigations/:id/views/:viewId/delete': 'reads no source: the application database',
  'POST /v1/investigations/:id/status': 'reads no source: the application database',
  'POST /v1/investigations/:id/views': 'reads no source: the application database',
  'POST /v1/investigations/:id/views/:viewId/restore': 'reads no source: the application database',
  'GET /v1/views': 'reads no source: the application database',
  'GET /v1/investigations/:id/views': 'reads no source: the application database',
  'PUT /v1/investigations/:id/views/:viewId': 'reads no source: the application database',
};

/** The routes under /v1 that read the source and are not on the list above. */
export function sourceReadingRoutesOf(routes: readonly { readonly method: string; readonly url: string }[], exempt: Readonly<Record<string, string>> = NOT_IN_THE_CLOSED_SET): string[] {
  return routes
    .filter((route) => route.method !== 'HEAD' && route.url.startsWith('/v1'))
    .map((route) => `${route.method} ${route.url}`)
    .filter((key) => !(key in exempt));
}

/** The source-reading routes the set does not build. */
export const missingFrom = (built: ReadonlySet<string>, routes: readonly string[]): string[] => routes.filter((key) => !built.has(key));

const linkedStatements = (statements: ReadonlySet<string>): string[] => [...statements].filter((statement) => statement.includes('cutFirst') && statement.includes('AS isTarget'));
const hasMatching = (statements: readonly string[], test: (statement: string) => boolean): boolean => statements.some(test);

describe('the closed set of the fuzz suite', () => {
  const built = routesOfClosedSet.get(closed) ?? new Set<string>();
  const routes = sourceReadingRoutesOf(registeredRoutesOf(rig.app));

  it('builds a statement set from every route that reads the source, so a new route cannot be left out', () => {
    expect(routes.length).toBeGreaterThan(8);
    expect(missingFrom(built, routes)).toEqual([]);
  });

  it('builds the routes of the inspector: the entity read, both forms of the edge read, the source link, derived neighbors and the investigation', () => {
    for (const key of ['GET /v1/entities/:sourceId/:entityType/:stableId', 'GET /v1/edges/:ref', 'GET /v1/source-links/:ref', 'POST /v1/graph/derived-neighbors', 'POST /v1/investigations']) expect(built.has(key), key).toBe(true);
  });

  describe('the pattern runs', () => {
    const linked = linkedStatements(closed);

    it('builds the run route, and the completeness test fails when it is taken out of the set', () => {
      const key = 'POST /v1/templates/:id/run';
      expect(built.has(key)).toBe(true);
      expect(missingFrom(new Set([...built].filter((route) => route !== key)), routes)).toEqual([key]);
    });

    it('holds statements of the linked-entities template for one hop and for two, in each direction, with and without a window', () => {
      expect(linked.length).toBeGreaterThan(3);
      expect(hasMatching(linked, (statement) => statement.includes('[] AS second'))).toBe(true);
      expect(hasMatching(linked, (statement) => !statement.includes('[] AS second'))).toBe(true);
      expect(hasMatching(linked, (statement) => statement.includes(']->'))).toBe(true);
      expect(hasMatching(linked, (statement) => statement.includes('<-['))).toBe(true);
      expect(hasMatching(linked, (statement) => /\)-\[[^\]]*\]-\(/.test(statement))).toBe(true);
      expect(hasMatching(linked, (statement) => statement.includes('`seenAt`'))).toBe(true);
      expect(hasMatching(linked, (statement) => !statement.includes('`seenAt`'))).toBe(true);
    });
  });

  it('fails when one route is taken out of the set', () => {
    for (const key of routes) {
      const without = new Set([...built].filter((route) => route !== key));
      expect(missingFrom(without, routes), key).toEqual([key]);
    }
  });

  it('fails for a route that is registered and is on no list', () => {
    expect(missingFrom(built, sourceReadingRoutesOf([...registeredRoutesOf(rig.app), { method: 'GET', url: '/v1/new-read/:id' }]))).toEqual(['GET /v1/new-read/:id']);
  });

  it('has a reason for every exempt route, and every exempt route exists', () => {
    const registered = new Set(registeredRoutesOf(rig.app).map((route) => `${route.method} ${route.url}`));
    for (const [key, reason] of Object.entries(NOT_IN_THE_CLOSED_SET)) {
      expect(reason.length, key).toBeGreaterThan(10);
      expect(registered.has(key), key).toBe(true);
    }
  });
});
