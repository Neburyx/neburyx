import { rmSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { createLogger } from './logger.js';
import { start } from './start.js';
import { memoryAppStore } from './testing/app-store.js';
import { makeWebRoot } from './testing/web-root.js';
import { makeExportDirectory } from './testing/export-directory.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
afterAll(() => rmSync(webRoot, { recursive: true, force: true }));

const APP_URL = 'postgres://app_user:app-secret@db.example.test:5432/neburyx';
const MIGRATION_SENTINEL = 'postgres://migration_user:migration-sentinel-secret@db.example.test:5432/neburyx';

async function serve(env: Readonly<Record<string, string>>): Promise<{ readonly status: number; readonly body: string; readonly headers: string; readonly log: string }> {
  const lines: string[] = [];
  const result = await start(
    { NEBURYX_WEB_ROOT: webRoot, ...env },
    {
      stderr: { write: (text) => lines.push(text) },
      logger: createLogger({ write: (chunk: string) => lines.push(chunk) }),
      defaultWebRoot: webRoot, defaultExportDirectory: exportDirectory,
      portOverride: 0,
      openStore: memoryAppStore,
      tasks: [],
    },
  );
  expect(result.exitCode).toBe(0);
  if (result.exitCode !== 0) throw new Error('the API did not start');
  const response = await result.app.inject({ method: 'GET', url: '/' });
  await result.app.close();
  return { status: response.statusCode, body: response.body, headers: JSON.stringify(response.headers), log: lines.join('') };
}

describe('the API and the database credentials', () => {
  it('starts and serves with only its own connection string set', async () => {
    const served = await serve({ DATABASE_URL: APP_URL });
    expect(served.status).toBe(200);
  });

  it('never logs, answers or keeps the migration connection string', async () => {
    const env = { DATABASE_URL: APP_URL, DATABASE_MIGRATION_URL: MIGRATION_SENTINEL };
    const served = await serve(env);
    expect(served.status).toBe(200);
    for (const text of [served.body, served.headers, served.log, JSON.stringify(parseConfig({ NEBURYX_WEB_ROOT: webRoot, ...env }, { webRoot }))]) {
      expect(text).not.toContain('migration-sentinel-secret');
      expect(text).not.toContain('migration_user');
    }
  });
});
