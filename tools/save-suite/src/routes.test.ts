import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { startSuite, type Suite } from './rig.js';

let suite: Suite | undefined;
afterEach(async () => {
  await suite?.close();
  suite = undefined;
});

/** The routes of the save, view, lifecycle and read-by-reference families, each with the file of this suite that drives it and the words of the call that file makes. */
const DRIVEN: Readonly<Record<string, { readonly file: string; readonly calls: RegExp }>> = {
  'POST /v1/investigations': { file: 'round-trip.test.ts', calls: /\.open\(/ },
  'GET /v1/investigations/:id': { file: 'restore-exactness.test.ts', calls: /openById|getInvestigation/ },
  'PUT /v1/investigations/:id/draft': { file: 'two-tabs.test.ts', calls: /saveDraft/ },
  'POST /v1/graph/read-refs': { file: 'restore-exactness.test.ts', calls: /\.load\(|readRefs/ },
  'POST /v1/investigations/:id/status': { file: 'read-only-join.test.ts', calls: /changeInvestigationStatus/ },
  'PUT /v1/investigations/:id': { file: 'source-change-layout.test.ts', calls: /renameInvestigation/ },
  'DELETE /v1/investigations/:id': { file: 'lifecycle.test.ts', calls: /deleteInvestigation/ },
  'POST /v1/investigations/:id/restore': { file: 'lifecycle.test.ts', calls: /restoreInvestigation/ },
  'GET /v1/investigations': { file: 'lifecycle.test.ts', calls: /listInvestigationPage/ },
  'POST /v1/investigations/:id/views': { file: 'named-views.test.ts', calls: /saveNamedView|saveView/ },
  'GET /v1/investigations/:id/views': { file: 'named-views.test.ts', calls: /listViews/ },
  'PUT /v1/investigations/:id/views/:viewId': { file: 'named-views.test.ts', calls: /renameView/ },
  'POST /v1/investigations/:id/views/:viewId/restore': { file: 'named-views.test.ts', calls: /restoreNamedView|restoreView/ },
  'POST /v1/investigations/:id/views/:viewId/delete': { file: 'named-views.test.ts', calls: /deleteView/ },
  'GET /v1/views': { file: 'named-views.test.ts', calls: /listOwnedViews/ },
  'POST /v1/investigations/:id/exports': { file: 'export.test.ts', calls: /createExport/ },
  'GET /v1/exports/:id/download': { file: 'export.test.ts', calls: /downloadExport/ },
};

/** The routes of those families this suite does not drive, with the reason. */
const EXEMPT: Readonly<Record<string, string>> = {
  'GET /v1/exports/:id': 'the web client never reads an export row by itself, only creates and downloads; the API tests of exports cover it',
};

const FAMILIES = /^(GET|POST|PUT|DELETE) \/v1\/(investigations|views|exports|graph\/read-refs)/;

/** The routes of the families that no case and no exemption names. */
export const unnamed = (routes: readonly string[], driven: Readonly<Record<string, unknown>> = DRIVEN): string[] => routes.filter((route) => FAMILIES.test(route) && !(route in driven) && !(route in EXEMPT));

describe('every route of the save families has a case in this suite', () => {
  it('names each route a case drives or lists it with a reason, and each name is a route that exists in a file that exists', async () => {
    suite = await startSuite();
    const routes = suite.routes();
    expect(routes.length).toBeGreaterThan(10);
    expect(unnamed(routes)).toEqual([]);
    for (const [route, { file, calls }] of Object.entries(DRIVEN)) {
      expect(routes, route).toContain(route);
      const path = fileURLToPath(new URL(file, import.meta.url));
      expect(existsSync(path), `${route} names ${file}`).toBe(true);
      expect(calls.test(readFileSync(path, 'utf8')), `${file} makes the call of ${route}`).toBe(true);
    }
    for (const route of Object.keys(EXEMPT)) expect(routes, route).toContain(route);
  });

  it('fails for a route taken out of the list and for a route added to the application', async () => {
    suite = await startSuite();
    const routes = suite.routes();
    const without = Object.fromEntries(Object.entries(DRIVEN).filter(([route]) => route !== 'GET /v1/views'));
    expect(unnamed(routes, without)).toEqual(['GET /v1/views']);
    expect(unnamed([...routes, 'POST /v1/investigations/:id/duplicate'])).toEqual(['POST /v1/investigations/:id/duplicate']);
  });
});
