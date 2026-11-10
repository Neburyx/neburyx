import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { apiRoutesOf, buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { memoryAppStore } from '../testing/app-store.js';
import { TEST_REFERENCE_KEYS } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';
import { DELETED_INVESTIGATION_ROUTES } from './deleted-routes.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const mapping = parseMapping(fileOf(baseSource()), 'neburyx.yaml');

describe('every route with an investigation ID is in the inventory of the deleted-investigation test', () => {
  it('lists each registered route that has an investigation ID in its path, and no route that is not registered', async () => {
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: testSourceGate(mapping, { referenceKeys: TEST_REFERENCE_KEYS }).gate, referenceKeys: TEST_REFERENCE_KEYS });
    const registered = apiRoutesOf(app).filter((route) => /^\/v1\/investigations\/:id(\/|$)/.test(route.url)).map((route) => `${route.method} ${route.url}`);
    const inventory = Object.keys(DELETED_INVESTIGATION_ROUTES);
    expect(registered.filter((route) => !inventory.includes(route))).toEqual([]);
    expect(inventory.filter((route) => !registered.includes(route))).toEqual([]);
    expect(registered.length).toBeGreaterThanOrEqual(11);
    await app.close();
  });
});
