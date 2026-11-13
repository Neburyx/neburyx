import { afterEach, describe, expect, it } from 'vitest';
import { startRig, type Rig } from './rig.js';

let rig: Rig;
afterEach(() => rig.close());

/** The routes whose slots, rate and breaker this suite drives through the rig (`Route` of `rig.ts`). */
const IN_THE_RIG: readonly string[] = [
  'GET /v1/entities/:sourceId/:entityType/:stableId',
  'GET /v1/edges/:ref',
  'GET /v1/source-links/:ref',
  'POST /v1/graph/derived-neighbors',
];

/** Every other route under /v1, with where it is covered or why it needs no case: each read takes its slot in the gate and its count in the request limiter, whatever the route. */
const ELSEWHERE: Readonly<Record<string, string>> = {
  'POST /v1/entities/lookup': 'counted in rate-routes.test.ts; the slot is the gate\'s, as for the entity read',
  'POST /v1/search/entities': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/search/entities/more': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/graph/preview-expansion': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/graph/expand': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/investigations': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/templates/:id/run': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/graph/coverage': 'reads no source',
  'POST /v1/patterns/validate': 'reads no source: it answers from the mapping and the definition, and takes no read slot',
  'POST /v1/graph/read-refs': 'counted in rate-routes.test.ts; the slot is the gate\'s',
  'POST /v1/sources/:id/test': 'counted in rate-routes.test.ts; it runs the source tester, not a gate read',
  'GET /v1/me': 'reads no source',
  'GET /v1/sources': 'reads no source',
  'GET /v1/sources/:id/profile': 'reads no source',
  'GET /v1/templates': 'reads no source',
  'GET /v1/investigations': 'reads no source',
  'GET /v1/investigations/:id': 'reads no source',
  'PUT /v1/investigations/:id/draft': 'reads no source',
  'PUT /v1/investigations/:id': 'reads no source',
  'DELETE /v1/investigations/:id': 'reads no source',
  'POST /v1/investigations/:id/restore': 'reads no source',
  'POST /v1/investigations/:id/views/:viewId/delete': 'reads no source',
  'POST /v1/investigations/:id/status': 'reads no source',
  'POST /v1/investigations/:id/views': 'reads no source',
  'POST /v1/investigations/:id/views/:viewId/restore': 'reads no source',
  'GET /v1/views': 'reads no source',
  'GET /v1/investigations/:id/views': 'reads no source',
  'PUT /v1/investigations/:id/views/:viewId': 'reads no source',
};

/** The routes under /v1 that neither the rig nor the list above names. */
export const unlisted = (routes: readonly string[], inRig: readonly string[] = IN_THE_RIG): string[] => routes.filter((key) => key.split(' ')[1]?.startsWith('/v1') === true && !inRig.includes(key) && !(key in ELSEWHERE));

describe('every route under /v1 has a place in this suite', () => {
  it('is driven by the rig or listed with a reason, so a new route cannot be left out', async () => {
    rig = await startRig();
    expect(rig.routes.length).toBeGreaterThan(10);
    expect(unlisted(rig.routes)).toEqual([]);
    for (const key of IN_THE_RIG) expect(rig.routes, key).toContain(key);
    for (const key of Object.keys(ELSEWHERE)) expect(rig.routes, key).toContain(key);
  });

  it('fails when a route the rig drives is taken out of its list, and for a new route', async () => {
    rig = await startRig();
    expect(unlisted(rig.routes, IN_THE_RIG.filter((key) => key !== 'POST /v1/graph/derived-neighbors'))).toEqual(['POST /v1/graph/derived-neighbors']);
    expect(unlisted([...rig.routes, 'GET /v1/new-read/:id'])).toEqual(['GET /v1/new-read/:id']);
  });
});
