import { rmSync } from 'node:fs';
import { edgeRefSegmentOf, sourceLinkSegmentOf } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import { createLogger } from '../logger.js';
import { parseMapping } from '../mapping/load.js';
import { deriveReferenceKeys } from '../reference/keys.js';
import { memoryAppStore } from '../testing/app-store.js';
import { entityRows, plainNode } from '../testing/entity-fixtures.js';
import { TestExecutor } from '../testing/gate.js';
import { baseSource, fileOf } from '../testing/mapping.js';
import { plainNode as relatedNode, plainRelationship } from '../testing/normalize-fixtures.js';
import { onlineIndexesOf, schemaAnswer, withSchema } from '../testing/search-fixtures.js';
import { testSourceGate } from '../testing/source-gate.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const HOST = 'records.sweep-marker.test';
const TEMPLATE_PATHS = ['/sweep-entity-path/', '/sweep-record-path/'];
const keys = deriveReferenceKeys(Buffer.alloc(32, 9));
const mapping = parseMapping(
  fileOf(
    baseSource({
      id: 'demo',
      entities: [
        { type: 'widget', label: 'Widget', stable_id: 'widgetId', link: `https://${HOST}${TEMPLATE_PATHS[0]}{widgetId}` },
        { type: 'gadget', label: 'Gadget', stable_id: 'gadgetId' },
      ],
      relationships: [{ type: 'MADE_FROM', from: 'widget', to: 'gadget', stable_id: 'linkId', evidence: ['recordId'], evidence_link: `https://${HOST}${TEMPLATE_PATHS[1]}{recordId}` }],
    }),
  ),
  'neburyx.yaml',
);
const [source] = mapping.sources;
if (source === undefined) throw new Error('the mapping has no source');

const widget = plainNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const relatedWidget = relatedNode(['Widget'], { widgetId: 'W-1' }, '4:s:1');
const relatedGadget = relatedNode(['Gadget'], { gadgetId: 'GT-1' }, '4:s:2');
const edgeRows: ExecuteOutcome = { status: 'rows', rows: [{ r: plainRelationship('MADE_FROM', relatedWidget, relatedGadget, { linkId: 'L-1', recordId: 'R-1' }, '5:s:1'), a: relatedWidget, b: relatedGadget }] };
const answer = (call: ExecuteCall): ExecuteOutcome => (call.templateId === 'edge-load' ? edgeRows : call.templateId === 'entity-load' ? entityRows(widget) : { status: 'rows', rows: [] });

const ENTITY = { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' };
const STORED = { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: 'L-1' };
const PARAMS: Readonly<Record<string, readonly string[]>> = {
  id: ['demo', 'nope'],
  sourceId: ['demo', 'nope'],
  entityType: ['widget', 'nope'],
  stableId: ['W-1', 'nope'],
  ref: [edgeRefSegmentOf(STORED), sourceLinkSegmentOf({ form: 'entity', ref: ENTITY }), 'not-a-reference'],
};
const BODIES: readonly unknown[] = [
  undefined,
  {},
  { sourceId: 'demo', text: 'W-1' },
  { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' } },
  { sourceId: 'demo', entity: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' } },
  { sourceId: 'demo', entities: [{ ref: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, loadedRelationships: 1, loadedQuality: 'exact' }] },
  { sourceId: 'demo', ref: { entityType: 'widget', stableId: 'W-1' }, neighborTypes: ['gadget'] },
  { sourceId: 'demo', value: { entityType: 'widget', value: 'W-1' } },
];

function urlsOf(url: string): string[] {
  if (url === '/v1/source-links/:ref') return [...PARAMS['ref']?.map((value) => `${url.replace(':ref', encodeURIComponent(value))}`) ?? [], `${url.replace(':ref', encodeURIComponent(edgeRefSegmentOf(STORED)))}?record=R-1`];
  const names = [...url.matchAll(/:(\w+)/g)].map((match) => match[1] ?? '');
  let urls = [url];
  for (const name of names) urls = urls.flatMap((current) => (PARAMS[name] ?? ['x']).map((value) => current.replace(`:${name}`, encodeURIComponent(value))));
  return urls;
}

describe('no response of any route holds the address of a source record', () => {
  it('holds for every registered route, valid and invalid input, with the Location of the source-links redirect the only place an address appears', async () => {
    const executor = new TestExecutor(withSchema(() => schemaAnswer(onlineIndexesOf(source)), (call) => Promise.resolve(answer(call))));
    const parts = testSourceGate(mapping, { executor, referenceKeys: keys });
    const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore(), mapping, gate: parts.gate, referenceKeys: keys });
    const routes = registeredRoutesOf(app).filter((route) => route.method !== 'HEAD' && (route.url.startsWith('/v1') || route.url === '/healthz' || route.url === '/readyz'));
    expect(routes.length).toBeGreaterThan(10);
    let calls = 0;
    let redirects = 0;
    let evidenceRedirects = 0;
    for (const route of routes) {
      const bodies = route.method === 'GET' ? [undefined] : BODIES;
      for (const url of urlsOf(route.url)) {
        for (const payload of bodies) {
          const response = await app.inject({ method: route.method === 'GET' ? 'GET' : 'POST', url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } }) });
          calls += 1;
          const isLink = route.url === '/v1/source-links/:ref' && response.statusCode === 302;
          const headers = Object.entries(response.headers).filter(([name]) => !(isLink && name === 'location'));
          const text = `${response.body}${JSON.stringify(headers)}`;
          expect(text, `${route.method} ${url}`).not.toContain(HOST);
          for (const path of TEMPLATE_PATHS) expect(text, `${route.method} ${url}`).not.toContain(path);
          if (isLink) {
            redirects += 1;
            if (url.includes('record=')) evidenceRedirects += 1;
            expect(response.body).toBe('');
            expect(response.headers['location']).toMatch(new RegExp(`^https://${HOST}/`));
          }
        }
      }
    }
    expect(calls).toBeGreaterThan(50);
    expect(redirects).toBeGreaterThan(0);
    expect(evidenceRedirects).toBeGreaterThan(0);
    await app.close();
  });
});
