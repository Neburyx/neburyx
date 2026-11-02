import { describe, expect, it } from 'vitest';
import { createSourceGate } from '../gate/source-gate.js';
import { communitySeams } from '../seams/community-seams.js';
import { mappingOf, sourceWith } from '../testing/gate-fixtures.js';
import { LOCAL_PRINCIPAL } from '../testing/gate.js';
import { createSourceTester } from './tester.js';
import { memoryAppStore } from '../testing/app-store.js';

// A check by hand against a server you run yourself, for the part a container cannot show: an Enterprise server lists privileges. It reads only, creates nothing,
// and is skipped unless the three variables are set. It is not part of any CI job.
const URI = process.env['NBX_EE_URI'];
const USER = process.env['NBX_EE_USER'];
const PASSWORD = process.env['NBX_EE_PASSWORD'];
const DATABASE = process.env['NBX_EE_DATABASE'] ?? 'neo4j';
const live = URI !== undefined && USER !== undefined && PASSWORD !== undefined;

describe.skipIf(!live)('the privileges read against an Enterprise server', () => {
  it('lists the privileges of the login in a read transaction on the source database, and the report says they were inspected', async () => {
    const mapping = mappingOf(sourceWith('live', { uri: URI, database: DATABASE, budgets: { timeout_ms: 10000, queue_wait_ms: 5000 }, auth: { kind: 'basic', username_env: 'NBX_EE_USER', password_env: 'NBX_EE_PASSWORD' } }));
    const warnings: object[] = [];
    const parts = createSourceGate({ mapping, env: { NBX_EE_USER: USER, NBX_EE_PASSWORD: PASSWORD }, seams: communitySeams(), logger: { warn: (fields) => void warnings.push(fields) } });
    try {
      const report = await createSourceTester({ gate: parts.gate, mapping, store: memoryAppStore() }).run({ traceId: 'tr-live', principal: LOCAL_PRINCIPAL, sourceId: 'live' });
      expect(report.server?.edition).toBe('enterprise');
      expect(warnings).toEqual([]);
      expect(report.readOnlyCheck).toBe('privileges-inspected');
      expect(typeof report.loginCanWrite).toBe('boolean');
    } finally {
      await parts.close();
    }
  }, 60_000);
});
