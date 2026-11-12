import { createServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuditEvent, AuditSinkContext, MountedAuditSink } from '@neburyx/contracts';
import pino from 'pino';
import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import { STORE_QUERY_TIMEOUT_MS, STORE_STATEMENT_TIMEOUT_MS } from '../app-store.js';
import { CONNECTION_TIMEOUT_MS, POOL_SIZE } from '../db/pool.js';
import { createSourceGate, type SourceGateOptions } from '../gate/source-gate.js';
import { uuidv7 } from '../identity/uuid.js';
import type { Seams } from '../seams/seams.js';
import { start, type StartIo } from '../start.js';
import { memoryAppStore } from '../testing/app-store.js';
import { makeExportDirectory } from '../testing/export-directory.js';
import { makeWebRoot } from '../testing/web-root.js';

const webRoot = makeWebRoot();
const exportDirectory = makeExportDirectory();
const folder = mkdtempSync(join(tmpdir(), 'audit-mount-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));
const previewFile = join(folder, 'preview.yaml');
writeFileSync(previewFile, stringify({ sources: [], ai: { preview: true } }));
const plainFile = join(folder, 'plain.yaml');
writeFileSync(plainFile, stringify({ sources: [] }));

const DATABASE_URL = 'postgres://app_user@db.example.test:5432/neburyx';
const EVENT: AuditEvent = { actorId: 'a', actorRole: 'viewer', action: 'graph.expand', result: 'success', traceId: 't' };

function rig() {
  const recorded: AuditEvent[] = [];
  const contexts: AuditSinkContext[] = [];
  const closed: string[] = [];
  const seams: Seams[] = [];
  const mounted: MountedAuditSink = { sink: { record: (event) => (recorded.push(event), Promise.resolve()) }, close: () => (closed.push('sink'), Promise.resolve()) };
  const io: StartIo = {
    stderr: { write: () => true },
    logger: pino({ level: 'silent' }),
    defaultWebRoot: webRoot,
    defaultExportDirectory: exportDirectory,
    openStore: memoryAppStore,
    openSourceGate: (options: SourceGateOptions) => (seams.push(options.seams), createSourceGate(options)),
    tasks: [],
    portOverride: 0,
    extensionLoader: { load: async () => ({ name: 'fake', routeGroups: [], createAuditSink: (context) => (contexts.push(context), mounted) }) },
  };
  return { io, recorded, contexts, closed, seams };
}

describe('the audit sink of the preview in a start', () => {
  it('is built once from the application\'s own login and the limits of its pool, and is the audit of the seams, when the switch is on', async () => {
    const { io, contexts, recorded, seams } = rig();
    const result = await start({ DATABASE_URL, DATABASE_MIGRATION_URL: 'postgres://owner@db.example.test:5432/neburyx', NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' }, io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(contexts).toHaveLength(1);
    expect(contexts[0]).toMatchObject({
      databaseUrl: DATABASE_URL,
      poolSize: POOL_SIZE,
      connectionTimeoutMs: CONNECTION_TIMEOUT_MS,
      statementTimeoutMs: STORE_STATEMENT_TIMEOUT_MS,
      queryTimeoutMs: STORE_QUERY_TIMEOUT_MS,
    });
    expect(uuidv7).toBe(contexts[0]?.newId);
    await seams[0]?.audit.record(EVENT);
    expect(recorded).toEqual([EVENT]);
    await result.app.close();
  });

  it('is not built when the switch is off, and the audit of the seams keeps nothing', async () => {
    const { io, contexts, recorded, seams } = rig();
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: plainFile }, io);
    expect(result.exitCode).toBe(0);
    if (result.exitCode !== 0) return;
    expect(contexts).toEqual([]);
    await expect(seams[0]?.audit.record(EVENT)).resolves.toBeUndefined();
    expect(recorded).toEqual([]);
    await result.app.close();
  });

  it('is closed once when the application closes', async () => {
    const { io, closed } = rig();
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' }, io);
    if (result.exitCode !== 0) throw new Error('the application did not start');
    expect(closed).toEqual([]);
    await result.app.close();
    expect(closed).toEqual(['sink']);
  });

  it('is closed when the start fails after it was built', async () => {
    const { io, closed } = rig();
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    try {
      const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise', NEBURYX_HOST: '127.0.0.1' }, { ...io, portOverride: port });
      expect(result.exitCode).toBe(1);
      expect(closed).toEqual(['sink']);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it('writes no event content or database URL to the log at a start of the preview', async () => {
    const { io } = rig();
    const lines: string[] = [];
    const result = await start({ DATABASE_URL, NEBURYX_CONFIG: previewFile, NEBURYX_PROFILE: 'enterprise' }, { ...io, logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(line) }) });
    if (result.exitCode !== 0) throw new Error('the application did not start');
    await result.app.close();
    expect(lines.join('')).not.toContain('db.example.test');
  });
});
