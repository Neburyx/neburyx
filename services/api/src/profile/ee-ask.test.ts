import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import pino from 'pino';
import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp, registeredRoutesOf } from '../app.js';
import { routesWithoutPermission } from '../permissions.js';
import { start, type StartIo } from '../start.js';
import { memoryAppStore } from '../testing/app-store.js';
import { checkOperations } from '../testing/contract-check.js';
import { loadCommittedDocument } from '../testing/document.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'ee-ask-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const previewFile = join(folder, 'preview.yaml');
writeFileSync(previewFile, stringify({ sources: [], ai: { preview: true } }));
const plainFile = join(folder, 'plain.yaml');
writeFileSync(plainFile, stringify({ sources: [] }));

const DATABASE_URL = 'postgres://app_user@db.example.test:5432/neburyx';
const startIo = (): StartIo => ({
  stderr: { write: () => true },
  logger: pino({ level: 'silent' }),
  defaultWebRoot: webRoot,
  defaultExportDirectory: exportDirectory,
  openStore: memoryAppStore,
  tasks: [],
  portOverride: 0,
  extensionLoader: { load: async () => createEnterpriseExtension() },
});

describe('the real enterprise extension in a start', () => {
  it('answers 404 and registers no route under /v1/ai when the switch is off', async () => {
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: plainFile }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect((await result.app.inject({ url: '/v1/ai/status' })).statusCode).toBe(404);
    expect(registeredRoutesOf(result.app).filter((route) => route.url.startsWith('/v1/ai'))).toEqual([]);
    await result.app.close();
  });

  it('answers 200 with the status and declares the principal permission when the switch is on', async () => {
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' }, startIo());
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    const answer = await result.app.inject({ url: '/v1/ai/status' });
    expect([answer.statusCode, answer.json()]).toEqual([200, { preview: true }]);
    expect(registeredRoutesOf(result.app).find((route) => route.url === '/v1/ai/status')).toMatchObject({ method: 'GET', permission: 'principal' });
    expect(routesWithoutPermission(registeredRoutesOf(result.app))).toEqual([]);
    await result.app.close();
  });

  it('is described by the committed contract when mounted', async () => {
    const app = await buildApp({ webRoot, logger: pino({ level: 'silent' }), store: memoryAppStore(), extension: createEnterpriseExtension() });
    const failures = await checkOperations(app, loadCommittedDocument(), {});
    expect(failures.filter((failure) => failure.route.includes('/v1/ai/status'))).toEqual([]);
    await app.close();
  });
});
