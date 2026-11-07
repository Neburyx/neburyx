import { describe, expect, it } from 'vitest';
import { memoryAppStore } from '../testing/app-store.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { identityHashOf } from '../registry/identity-hash.js';
import { fakeSourceTester } from '../testing/source-tester.js';
import { createUsabilityRecord } from './usability.js';
import { refreshUsability } from './usability-refresh.js';

const mapping = mappingOf(sourceWith('alpha'));
const SINCE = '2026-11-02T09:00:00.000Z';
const logger = () => {
  const lines: object[] = [];
  return { lines, warn: (fields: object) => void lines.push(fields) };
};

describe('refreshing the record from the stored checks', () => {
  it('takes the verdict of a check stored by another process, and ignores the checks of another mapping', async () => {
    const store = memoryAppStore();
    const { tester } = fakeSourceTester(mapping, undefined, store);
    await tester.run({ traceId: 't', principal: (await store.current()).principal, sourceId: 'alpha' });
    const record = createUsabilityRecord();
    await refreshUsability(store, record, mapping, SINCE, logger());
    expect(record.verdictOf('alpha')).toBe('usable');
    const other = createUsabilityRecord();
    await refreshUsability(store, other, mappingOf(sourceWith('alpha', { database: 'another' })), SINCE, logger());
    expect(other.verdictOf('alpha')).toBe('unchecked');
  });

  it('ignores a check stored before the process started', async () => {
    const store = memoryAppStore();
    const { tester } = fakeSourceTester(mapping, undefined, store);
    await tester.run({ traceId: 't', principal: (await store.current()).principal, sourceId: 'alpha' });
    const record = createUsabilityRecord();
    await refreshUsability(store, record, mapping, '2026-11-02T11:00:00.000Z', logger());
    expect(record.verdictOf('alpha')).toBe('unchecked');
  });

  it('keeps what the record holds when there is nothing newer, and when the store fails, and says so once without detail', async () => {
    const record = createUsabilityRecord();
    record.observe({ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:10.000Z', server: { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' }, mappingChecks: { status: 'pass', findings: [] } });
    const log = logger();
    await refreshUsability({ latestQualifyingChecks: () => Promise.resolve([]) }, record, mapping, SINCE, log);
    expect(record.verdictOf('alpha')).toBe('usable');
    await refreshUsability({ latestQualifyingChecks: () => Promise.reject(new Error('the password is hunter2')) }, record, mapping, SINCE, log);
    expect(record.verdictOf('alpha')).toBe('usable');
    expect(log.lines).toEqual([{ event: 'source.usability_refresh_failed' }]);
  });

  it('logs a row that could not be read with the source id only, and goes on with the others', async () => {
    const record = createUsabilityRecord();
    const log = logger();
    const reached = { product: 'Neo4j Kernel', version: '5.26.32', edition: 'community' };
    await refreshUsability(
      {
        latestQualifyingChecks: (_sources, _since, onUnreadable) => {
          onUnreadable?.('beta', '2026-11-02T10:00:05.000Z');
          return Promise.resolve([{ sourceId: 'alpha', checkedAt: '2026-11-02T10:00:10.000Z', report: { sourceId: 'alpha', checkedAt: '2026-11-02T10:00:10.000Z', server: reached, mappingChecks: { status: 'pass', findings: [] } } as never }]);
        },
      },
      record,
      mapping,
      SINCE,
      log,
    );
    expect(log.lines).toEqual([{ event: 'source.usability_row_unreadable', sourceId: 'beta' }]);
    expect(record.verdictOf('alpha')).toBe('usable');
  });

  it('asks for the identity and the config hash of each source of the mapping', async () => {
    const asked: unknown[] = [];
    await refreshUsability({ latestQualifyingChecks: (sources, since) => (asked.push([sources, since]), Promise.resolve([])) }, createUsabilityRecord(), mapping, SINCE, logger());
    const [source] = mapping.sources;
    expect(asked).toEqual([[[{ id: 'alpha', identityHash: source ? identityHashOf(source) : '', configHash: source?.configHash }], SINCE]]);
  });
});
