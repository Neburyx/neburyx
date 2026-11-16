import type { CaseSummarizer } from '@neburyx/contracts';
import { createSummaryRoute, guardAiRouteGroup } from '@neburyx/ee-ask';
import { afterEach, describe, expect, it } from 'vitest';
import { expectNothingLeft, finishAll, startRig, type Rig, type RigOptions } from './rig.js';

let rig: Rig;
afterEach(async () => {
  await rig.close();
  expectNothingLeft(rig);
});

const SUMMARIZER: CaseSummarizer = { maxElements: 300, maxOutputTokens: 4000, availability: () => ({ available: true }), summarize: async () => ({ status: 'ok', sentences: [], citations: [], coverage: { retrieval: '0 shown', summary: 'No sentence was kept.' }, removedCount: 0, sent: '', model: 'stub', calls: 1, summaryToken: 'v1.stub' }) };
const withSummary = (extra: RigOptions = {}): RigOptions => ({ ...extra, summary: true, caseSummarizer: SUMMARIZER, extension: { name: 'summary', routeGroups: [guardAiRouteGroup({ routes: [createSummaryRoute()] })] } });

describe('a summary request, which reads the elements of a view through the gate', () => {
  it('takes a read slot of the person for its read and frees it when the read is answered', async () => {
    rig = await startRig(withSummary());
    const sent = rig.http(undefined, 'summary');
    await rig.until(() => rig.personHolds().held === 1, 'the summary holds a slot');
    expect(rig.data.started).toBe(1);
    await finishAll(rig, [sent]);
    expect((await sent).status).toBe(200);
  });

  it('answers SOURCE_BUSY, reaching the source no more, when the person has no slot left for it within the wait', async () => {
    rig = await startRig(withSummary({ budgets: { user_concurrency: 1 } }));
    const holder = rig.http(undefined, 'summary');
    await rig.until(() => rig.personHolds().held === 1, 'the slot is held');
    const refused = rig.http(undefined, 'summary');
    await rig.until(() => rig.personHolds().waiting === 1, 'the second waits');
    await rig.advance(2000);
    expect(await refused).toMatchObject({ status: 503, body: { error: { code: 'SOURCE_BUSY' } } });
    expect(rig.data.started).toBe(1);
    await finishAll(rig, [holder]);
  });
});
