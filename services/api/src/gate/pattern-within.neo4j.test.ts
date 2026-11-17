import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withinMinutesOf } from '@neburyx/contracts';
import { communitySeams } from '../seams/community-seams.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../testing/gate.js';
import { envFor, NEO4J_SERIES, runAdmin, runAll, sourceFor, startNeo4j, type RunningNeo4j } from '../testing/neo4j-server.js';
import { isNormalizedPattern } from './normalize/pattern.js';
import { isNormalizedPatternCount } from './normalize/pattern-count.js';
import { createSourceGate, type SourceGate } from './source-gate.js';
import { PATTERN_ID } from './templates/pattern.js';
import { PATTERN_COUNT_ID } from './templates/pattern-count.js';

let server: RunningNeo4j;
let parts: SourceGate;

const entities = [{ type: 'maker', label: 'WMaker', stable_id: 'makerId' }];
const relationships = [{ type: 'LINKS', from: 'maker', to: 'maker', stable_id: 'linkId', observed_at: 'seenAt' }];

const FIRST = '2026-03-01T00:00:00Z';
const chains: Record<string, string | undefined> = {
  // the second transfer's time, after the first at 2026-03-01T00:00:00Z
  zero: '2026-03-01T00:00:00Z',
  ninety: '2026-03-01T01:30:00Z',
  day: '2026-03-02T00:00:00Z',
  dayAndMinute: '2026-03-02T00:01:00Z',
  threeDays: '2026-03-04T00:00:00Z',
  earlier: '2026-02-28T23:59:00Z',
  missing: undefined,
  text: 'next week',
};
let edges = 0;
const link = (from: string, to: string, value: string | undefined, text = false): string =>
  `MATCH (x:WMaker {makerId: '${from}'}), (y:WMaker {makerId: '${to}'}) CREATE (x)-[:LINKS {linkId: 'r${(edges += 1)}'${value === undefined ? '' : `, seenAt: ${text ? `'${value}'` : `datetime('${value}')`}`}}]->(y)`;

beforeAll(async () => {
  server = await startNeo4j();
  await runAdmin(server, 'CREATE CONSTRAINT w_maker FOR (n:WMaker) REQUIRE n.makerId IS UNIQUE');
  const names = Object.keys(chains);
  await runAdmin(server, `UNWIND [${names.flatMap((name) => [`'a-${name}'`, `'b-${name}'`, `'c-${name}'`]).join(',')}] AS id CREATE (:WMaker {makerId: id})`);
  for (const name of names) {
    await runAdmin(server, link(`a-${name}`, `b-${name}`, FIRST));
    await runAdmin(server, link(`b-${name}`, `c-${name}`, chains[name], name === 'text'));
  }
  await runAdmin(server, 'CALL db.awaitIndexes(300)');
  const defaults = communitySeams();
  parts = createSourceGate({ mapping: { sources: [sourceFor(server, { entities, relationships, derived: [], budgets: {} })] }, env: envFor(server), seams: { policy: defaults.policy, coordinator: defaults.coordinator, audit: defaults.audit }, logger: { warn: () => undefined } });
}, 300_000);

afterAll(async () => {
  await runAll([() => parts?.close(), () => server?.stop()]);
});

const hop = (over: Record<string, unknown> = {}) => ({ relationshipTypes: ['LINKS'], direction: 'out', arrivesAt: 'maker', ...over });

/** The matches of a run; the count read of the same parameters must agree with it on a fixture nothing cuts. */
async function reach(name: string, second: Record<string, unknown>): Promise<string[]> {
  const params = { anchorType: 'maker', stableId: `a-${name}`, steps: [hop(), hop(second)] };
  const page = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_ID, params, limit: 25 }));
  const [item] = page.items;
  if (!isNormalizedPattern(item)) throw new Error('the read gave no pattern result');
  const counted = await parts.gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: PATTERN_COUNT_ID, params, limit: 1 }));
  const [count] = counted.items;
  if (!isNormalizedPatternCount(count)) throw new Error('the read gave no pattern count');
  const ids = item.matches.map((entry) => entry.match.stableId).sort();
  expect(count.matches, `the count agrees with the run for ${name}`).toBe(ids.length);
  return ids;
}

const ordered = { after: 'previous' };
const within = (minutes: number) => ({ ...ordered, withinMinutes: minutes });
const DAY = withinMinutesOf({ days: 1 });

describe(`a delay after the previous step, read on ${NEO4J_SERIES}`, () => {
  it('includes a gap of no time and a gap of exactly the length, and leaves out a gap of one minute more, a gap before the first, a missing time and a time that is text', async () => {
    expect(await reach('zero', within(DAY))).toEqual(['c-zero']);
    expect(await reach('ninety', within(DAY))).toEqual(['c-ninety']);
    expect(await reach('day', within(DAY))).toEqual(['c-day']);
    for (const name of ['dayAndMinute', 'threeDays', 'earlier', 'missing', 'text']) expect(await reach(name, within(DAY)), name).toEqual([]);
  });

  it('includes a gap of one minute more than a day when the length is a day and a minute, and the exact boundary of a short length', async () => {
    expect(await reach('dayAndMinute', within(DAY + 1))).toEqual(['c-dayAndMinute']);
    expect(await reach('ninety', within(89))).toEqual([]);
    expect(await reach('ninety', within(90))).toEqual(['c-ninety']);
  });

  it('reads the same length the same way in minutes, in hours and in days', async () => {
    const lengths = [{ minutes: 1440 }, { hours: 24 }, { days: 1 }];
    for (const name of ['day', 'dayAndMinute', 'threeDays']) {
      const sets = await Promise.all(lengths.map((length) => reach(name, within(withinMinutesOf(length)))));
      expect(new Set(sets.map((ids) => ids.join(','))).size, name).toBe(1);
    }
    expect(await reach('threeDays', within(withinMinutesOf({ days: 3 })))).toEqual(['c-threeDays']);
    expect(await reach('threeDays', within(withinMinutesOf({ hours: 71 })))).toEqual([]);
  });

  it('reads the order alone as before: with no length every chain with a usable later time is returned', async () => {
    for (const name of ['zero', 'ninety', 'day', 'dayAndMinute', 'threeDays']) expect(await reach(name, ordered), name).toEqual([`c-${name}`]);
    for (const name of ['earlier', 'missing', 'text']) expect(await reach(name, ordered), name).toEqual([]);
  });
});
