import { existsSync, readdirSync } from 'node:fs';
import { aiStatusResponseSchema } from '@neburyx/contracts';
import { createAuditSink } from '@neburyx/ee-audit';
import { describe, expect, it } from 'vitest';
import { AI_STATUS_URL, createEnterpriseExtension } from './index.js';

describe('the enterprise extension', () => {
  it('has one route group with the status route, which answers its declared schema', async () => {
    const extension = createEnterpriseExtension();
    const [group, ...others] = extension.routeGroups;
    expect(others).toEqual([]);
    const [route, ...more] = group?.routes ?? [];
    expect(more).toEqual([]);
    expect([route?.method, route?.url, route?.permission]).toEqual(['GET', AI_STATUS_URL, 'principal']);
    const reply = await route?.handler({ principalId: 'p', principalRole: 'investigator', previewOn: true, traceId: 'tr-1', audit: { record: async () => undefined } });
    expect(aiStatusResponseSchema.safeParse(reply).success).toBe(true);
    expect(route?.responseSchema).toBe(aiStatusResponseSchema);
  });

  it('refuses the status route when the request reports the preview off, and records the refusal', async () => {
    const [group] = createEnterpriseExtension().routeGroups;
    const events: unknown[] = [];
    const request = { principalId: 'p', principalRole: 'investigator' as const, previewOn: false, traceId: 'tr-1', audit: { record: async (event: unknown) => void events.push(event) } };
    await expect(group?.routes[0]?.handler(request) ?? Promise.resolve()).rejects.toMatchObject({ code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited: true });
    expect(events).toHaveLength(1);
  });

  it('names a migrations folder that exists in the repository and holds the audit and run tables', () => {
    const folder = createEnterpriseExtension().migrationsDirectory;
    expect(folder).toBeDefined();
    if (folder === undefined) return;
    expect(existsSync(folder)).toBe(true);
    expect(readdirSync(folder).filter((file) => file.endsWith('.sql'))).toEqual(['0001-audit-events.sql', '0002-ask-runs.sql']);
  });

  it('hands the sink it mounted to the audited call, which has none before the application built it, and returns the mounted sink unchanged', async () => {
    const extension = createEnterpriseExtension();
    expect(extension.auditSink()).toBeUndefined();
    const mounted = extension.createAuditSink?.({ databaseUrl: 'postgres://app@db.example.test:5432/neburyx', poolSize: 1, connectionTimeoutMs: 100, statementTimeoutMs: 100, queryTimeoutMs: 100, newId: () => 'id', onConnectionError: () => undefined });
    expect(mounted).toBeDefined();
    expect(extension.auditSink()).toBe(mounted?.sink);
    await mounted?.close();
  });

  it('builds the sink with the audit package', () => {
    expect(typeof createAuditSink).toBe('function');
    expect(createEnterpriseExtension().createAuditSink).toBeDefined();
  });
});
