import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { createLogger } from '../logger.js';
import { memoryAppStore } from '../testing/app-store.js';
import { INDEX_HTML, makeWebRoot, NOTICES_FILE } from '../testing/web-root.js';
import { RESERVED_SOURCE_IDS } from '../mapping/reserved-source-ids.js';

const webRoot = makeWebRoot();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const OWNED = ['v1', 'healthz', 'readyz', 'assets', 'index.html', NOTICES_FILE, 'explore', 'investigations', 'sources', 'dev'];
const NEARBY = ['v10', 'v1-other', 'V1', 'v1.a', 'xv1', 'v', 'assets2'];

async function classified(segments: readonly string[]): Promise<Record<string, 'page' | 'collides'>> {
  const app = await buildApp({ webRoot, logger: createLogger({ write: () => undefined }), store: memoryAppStore() });
  const out: Record<string, 'page' | 'collides'> = {};
  for (const segment of segments) {
    const response = await app.inject({ method: 'GET', url: `/${segment}/entity/widget/W-1?caseRef=CASE-1` });
    out[segment] = response.statusCode === 200 && response.body === INDEX_HTML ? 'page' : 'collides';
  }
  await app.close();
  return out;
}

describe('the first segment of a deep link on the production server', () => {
  it('is answered with the page for every path the server, the probes and the web app own except the API prefix', async () => {
    const answers = await classified(OWNED);
    expect(Object.entries(answers).filter(([, answer]) => answer === 'collides').map(([segment]) => segment)).toEqual(['v1']);
  });

  it('is answered with the page for an ID next to the API prefix', async () => {
    const answers = await classified(NEARBY);
    expect(Object.values(answers).every((answer) => answer === 'page')).toBe(true);
  });

  it('names exactly the segments that collide as the source IDs the mapping refuses', async () => {
    const answers = await classified([...OWNED, ...NEARBY]);
    const colliding = Object.entries(answers).filter(([, answer]) => answer === 'collides').map(([segment]) => segment);
    expect([...RESERVED_SOURCE_IDS].sort()).toEqual(colliding.sort());
  });
});
