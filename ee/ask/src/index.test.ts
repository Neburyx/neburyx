import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { UNAVAILABLE_SUMMARIZER } from './testing/case-summarizer.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuditSink } from '@neburyx/ee-audit';
import { afterAll, describe, expect, it } from 'vitest';
import { createEnterpriseExtension } from './index.js';
import { makeAskFolder, removeAskFolders } from './testing/ask-folder.js';

describe('the enterprise extension', () => {
  it('has one route group of the routes of a turn, a question and a summary, and none for the status, which is the application\'s own', () => {
    const extension = createEnterpriseExtension();
    const [group, ...others] = extension.routeGroups;
    expect(others).toEqual([]);
    expect((group?.routes ?? []).map((entry) => [entry.method, entry.url, entry.permission])).toEqual([['GET', '/v1/assistant/investigations/:id/thread', 'principal'], ['POST', '/v1/assistant/investigations/:id/thread/clear', 'principal'], ['POST', '/v1/assistant/turns', 'principal'], ['POST', '/v1/ask', 'principal'], ['POST', '/v1/ask/continue', 'principal'], ['POST', '/v1/summary', 'principal'], ['POST', '/v1/investigations/:id/draft/ai-notes', 'principal'], ['GET', '/v1/investigations/:id/draft/ai-notes', 'principal']]);
  });

  it('refuses the first route of its group when the request reports the routes off, and records the refusal', async () => {
    const [group] = createEnterpriseExtension().routeGroups;
    const events: unknown[] = [];
    const request = { principalId: 'p', principalRole: 'investigator' as const, previewOn: false, traceId: 'tr-1', audit: { record: async (event: unknown) => void events.push(event) }, askClassifier: { availability: () => ({ available: false, reason: 'x' }), classify: async () => ({ ok: false as const, cause: 'unavailable' as const }) }, caseSummarizer: UNAVAILABLE_SUMMARIZER, signal: new AbortController().signal };
    await expect(group?.routes[0]?.handler(request) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-off', audited: true });
    expect(events).toHaveLength(1);
  });

  it('names a migrations folder that exists in the repository and holds the audit table', () => {
    const folder = createEnterpriseExtension().migrationsDirectory;
    expect(folder).toBeDefined();
    if (folder === undefined) return;
    expect(existsSync(folder)).toBe(true);
    expect(folder).toBe(fileURLToPath(new URL('../../migrations', import.meta.url)));
    const statements = readdirSync(folder)
      .filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(join(folder, file), 'utf8'))
      .join('\n');
    expect(statements).toContain('CREATE TABLE audit_events');
    expect(statements).toContain('CREATE TABLE ask_runs');
    expect(statements).toContain('DROP TABLE ask_plans');
    expect(statements).toContain('ALTER TABLE ask_runs ADD COLUMN intent');
    expect(statements).toContain('CREATE TABLE summary_runs');
    expect(statements).toContain('CREATE TABLE summary_run_calls');
    expect(statements).toContain('CREATE TABLE summary_run_removals');
  });

  it('hands the sink it mounted to the audited call, which has none before the application built it, and returns the mounted sink unchanged', async () => {
    const extension = createEnterpriseExtension();
    expect(extension.auditSink()).toBeUndefined();
    const mounted = extension.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined });
    expect(mounted).toBeDefined();
    expect(extension.auditSink()).toBe(mounted?.sink);
    await mounted?.close();
  });

  it('mounts a run store with the sink, and one close ends both, attempting the second when the first fails', async () => {
    const closed: string[] = [];
    const runStore = () => ({ record: async () => undefined, close: async () => void closed.push('runs') });
    const extension = createEnterpriseExtension({ runStore });
    const mounted = extension.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined });
    await mounted?.close();
    await mounted?.close();
    expect(closed).toEqual(['runs']);

    const failing = createEnterpriseExtension({ runStore: () => ({ record: async () => undefined, close: () => Promise.reject(new Error('end failed')) }) });
    const other = failing.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined });
    await expect(other?.close()).rejects.toThrow('end failed');
  });

  it('has no stored question, no maintenance task and no second Ask path, and no classifier before it is configured and the audit is mounted', () => {
    const extension = createEnterpriseExtension() as unknown as Record<string, unknown>;
    expect(extension['planStore']).toBeUndefined();
    expect(extension['maintenanceTasks']).toBeUndefined();
    expect(extension['askPlanner']).toBeUndefined();
    expect((extension as unknown as { askClassifier: () => unknown })['askClassifier']()).toBeUndefined();
  });

  describe('the model behind the audit', () => {
    const SETTINGS = { preview: true };
    const CONTEXT = { sourceIds: ['source-a'] };
    const FOLDER = makeAskFolder(CONTEXT.sourceIds);
    afterAll(removeAskFolders);
    const ENV = { NEBURYX_ASK_API_KEY: 'not-a-real-key', NEBURYX_ASK_MAPPING_FOLDER: FOLDER, NEBURYX_ASK_CLASSIFICATION_MODEL: 'claude-sonnet-5-5' };
    const SINK_CONTEXT = { databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined };

    it('is undefined before the configuration and the mounted sink both exist', async () => {
      const unconfigured = createEnterpriseExtension();
      expect(unconfigured.model()).toBeUndefined();
      const mounted = unconfigured.createAuditSink?.(SINK_CONTEXT);
      expect(unconfigured.model()).toBeUndefined();
      await mounted?.close();

      const withoutSink = createEnterpriseExtension();
      expect((await withoutSink.configure?.(SETTINGS, ENV, CONTEXT))?.ok).toBe(true);
      expect(withoutSink.model()).toBeUndefined();
    });

    it('is the audited call once both exist, and stays undefined when the configuration is refused', async () => {
      const extension = createEnterpriseExtension();
      expect((await extension.configure?.(SETTINGS, ENV, CONTEXT))?.ok).toBe(true);
      const mounted = extension.createAuditSink?.(SINK_CONTEXT);
      const model = extension.model();
      expect(model).toBeDefined();
      expect(typeof model?.call).toBe('function');
      expect(typeof model?.asProvider).toBe('function');
      await mounted?.close();

      const refused = createEnterpriseExtension();
      expect((await refused.configure?.(SETTINGS, { ...ENV, NEBURYX_ASK_API_KEY: undefined }, CONTEXT))?.ok).toBe(false);
      const other = refused.createAuditSink?.(SINK_CONTEXT);
      expect(refused.model()).toBeUndefined();
      await other?.close();
    });
  });

  it('builds the sink with the audit package', () => {
    expect(typeof createAuditSink).toBe('function');
    expect(createEnterpriseExtension().createAuditSink).toBeDefined();
  });
});
