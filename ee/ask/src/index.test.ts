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
    const reply = await route?.handler({ principalId: 'p' });
    expect(aiStatusResponseSchema.safeParse(reply).success).toBe(true);
    expect(route?.responseSchema).toBe(aiStatusResponseSchema);
  });

  it('names a migrations folder that exists in the repository and holds the audit and run tables', () => {
    const folder = createEnterpriseExtension().migrationsDirectory;
    expect(folder).toBeDefined();
    if (folder === undefined) return;
    expect(existsSync(folder)).toBe(true);
    expect(readdirSync(folder).filter((file) => file.endsWith('.sql'))).toEqual(['0001-audit-events.sql', '0002-ask-runs.sql']);
  });

  it('supplies the audit sink of the preview', () => {
    expect(createEnterpriseExtension().createAuditSink).toBe(createAuditSink);
  });
});
