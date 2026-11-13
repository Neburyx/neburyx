import { idleExportDeps } from '../testing/export-deps.js';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import type { AuditEvent } from '../seams/seams.js';
import { maintenanceTasks, purgeDeletedInvestigations, purgeDeletedPatterns, type MaintenanceDeps } from './maintenance.js';
import { validateTasks } from './tasks.js';

function depsWith(purge: MaintenanceDeps['store']['purgeExpiredInvestigations'], audited: AuditEvent[] = [], lines: string[] = []): MaintenanceDeps {
  return {
    ...idleExportDeps(),
    store: { purgeExpiredPatterns: () => Promise.resolve(0), purgeExpiredInvestigations: purge },
    audit: { record: (event) => { audited.push(event); return Promise.resolve(); } },
    logger: createLogger({ write: (line: string) => void lines.push(line) }),
  };
}

describe('the shipped maintenance tasks', () => {
  it('hold the two purges and the export expiry, once each, with a daily schedule that is a valid cron expression', () => {
    const tasks = maintenanceTasks(depsWith(() => Promise.resolve(0)));
    expect(tasks.map((task) => [task.name, task.schedule])).toEqual([['purge-deleted-investigations', '17 3 * * *'], ['purge-deleted-patterns', '29 3 * * *'], ['expire-exports', '41 3 * * *']]);
    expect(() => validateTasks(tasks)).not.toThrow();
  });

  it('run the purge when the task runs', async () => {
    let runs = 0;
    const [task] = maintenanceTasks(depsWith(() => Promise.resolve(++runs)));
    await task?.run(undefined);
    expect(runs).toBe(1);
  });
});

describe('purgeDeletedInvestigations', () => {
  it('records one purge event for each investigation before it is deleted, as the system, and logs the count only', async () => {
    const audited: AuditEvent[] = [];
    const lines: string[] = [];
    const count = await purgeDeletedInvestigations(depsWith(async (beforeDelete) => {
      await beforeDelete({ id: '0192f000-0000-7000-8000-0000000000c1', sourceId: 'demo' });
      await beforeDelete({ id: '0192f000-0000-7000-8000-0000000000c2', sourceId: 'demo' });
      return 2;
    }, audited, lines));
    expect(count).toBe(2);
    expect(audited).toEqual([expect.objectContaining({ action: 'investigation.purge', actorRole: 'system', sourceId: 'demo' }), expect.objectContaining({ action: 'investigation.purge' })]);
    const logged = lines.join('');
    expect(logged).toContain('investigation.purged');
    expect(logged).not.toContain('0192f000-0000-7000-8000-0000000000c1');
  });

  it('raises when the audit sink rejects an event, so the runner retries the task', async () => {
    const deps: MaintenanceDeps = { ...idleExportDeps(), store: { purgeExpiredPatterns: () => Promise.resolve(0), purgeExpiredInvestigations: async (beforeDelete) => { await beforeDelete({ id: 'x', sourceId: 'demo' }); return 1; } }, audit: { record: () => Promise.reject(new Error('the sink is down')) }, logger: createLogger({ write: () => undefined }) };
    await expect(purgeDeletedInvestigations(deps)).rejects.toThrow('the sink is down');
  });
});

describe('purgeDeletedPatterns', () => {
  it('records one purge event for each pattern as the system, with the source and nothing of the pattern, and logs the count only', async () => {
    const audited: AuditEvent[] = [];
    const lines: string[] = [];
    const deps: MaintenanceDeps = {
      ...depsWith(() => Promise.resolve(0), audited, lines),
      store: {
        purgeExpiredInvestigations: () => Promise.resolve(0),
        purgeExpiredPatterns: async (beforeDelete) => {
          await beforeDelete({ id: '0192f000-0000-7000-8000-0000000000d1', sourceId: 'demo' });
          await beforeDelete({ id: '0192f000-0000-7000-8000-0000000000d2', sourceId: 'demo' });
          return 2;
        },
      },
    };
    expect(await purgeDeletedPatterns(deps)).toBe(2);
    expect(audited).toEqual([expect.objectContaining({ action: 'pattern.purge', actorId: 'system', actorRole: 'system', sourceId: 'demo' }), expect.objectContaining({ action: 'pattern.purge' })]);
    expect(audited.every((event) => event.resourceRef === undefined && event.detail === undefined)).toBe(true);
    const logged = lines.join('');
    expect(logged).toContain('pattern.purged');
    expect(logged).not.toContain('0192f000-0000-7000-8000-0000000000d1');
  });

  it('raises when the audit sink rejects an event, so the runner retries the task', async () => {
    const deps: MaintenanceDeps = {
      ...depsWith(() => Promise.resolve(0)),
      store: { purgeExpiredInvestigations: () => Promise.resolve(0), purgeExpiredPatterns: async (beforeDelete) => (await beforeDelete({ id: 'x', sourceId: 'demo' }), 1) },
      audit: { record: () => Promise.reject(new Error('the sink is down')) },
    };
    await expect(purgeDeletedPatterns(deps)).rejects.toThrow('the sink is down');
  });
});
