import type { Cell, PreviewCell } from './measure.js';
import type { Profile } from './profile.js';
import type { Sample } from './stats.js';
import { MEMBERS_PER_NEIGHBOR, PAGE, SAMPLES_PER_POSITION, type ReadSet } from './plan.js';

export const TARGET_MS = 3000;
const BASELINE_SIZE = 100_000;

export interface Stopped {
  readonly size: number;
  readonly readSet: ReadSet;
  readonly atRow: number;
  readonly notReached: readonly string[];
}

export interface RunData {
  readonly date: string;
  /** The commit whose code the run exercised, and a note on what that code did not yet have, when a later commit changed the read path. */
  readonly commit?: string;
  readonly note?: string;
  readonly neo4j: { readonly version: string; readonly edition: string };
  /** Whether the server's address is a loopback address, as the run found; the address itself is never recorded. */
  readonly serverIsLoopback: boolean;
  readonly cold: Sample;
  readonly cells: readonly Cell[];
  readonly stopped: readonly Stopped[];
  readonly previews: readonly PreviewCell[];
  readonly profiles: readonly Profile[];
}

/** A cell whose failed calls are more than a twentieth of its samples has a p95 that is a failed call's length, which is only a lower bound of what the call would have taken. */
export const isLowerBound = (cell: Pick<Cell, 'failures' | 'samples'>): boolean => cell.failures * 20 > cell.samples;

export interface Verdict {
  /** True only when every cell at 100,000 was measured, none rests on failed calls, and every p95 is under the target. */
  readonly met: boolean;
  readonly worstP95: number;
  readonly worst: { readonly readSet: ReadSet; readonly position: string };
  readonly overTarget: readonly { readonly readSet: ReadSet; readonly position: string; readonly p95: number }[];
  /** Cells at 100,000 whose p95 is "at least" its figure. */
  readonly lowerBound: readonly { readonly readSet: ReadSet; readonly position: string }[];
  /** Read sets at 100,000 whose walk stopped, so that positions are missing. */
  readonly stopped: readonly Stopped[];
}

/**
 * The baseline: the largest p95 of any cell at 100,000 relationships, so that no read set or position hides behind another. The target is met only when every one of them is under it, none is "at least" (a failed call's length is not
 * its cost) and every walk at 100,000 reached every position.
 */
export function verdictOf(cells: readonly Cell[], stopped: readonly Stopped[] = []): Verdict {
  const baseline = cells.filter((cell) => cell.size === BASELINE_SIZE);
  const worst = baseline.reduce<Cell | undefined>((best, cell) => (best === undefined || cell.p95 > best.p95 ? cell : best), undefined);
  if (worst === undefined) throw new Error('the run holds no cell at 100,000 relationships');
  const overTarget = baseline.filter((cell) => cell.p95 >= TARGET_MS).map((cell) => ({ readSet: cell.readSet, position: cell.position, p95: cell.p95 }));
  const lowerBound = baseline.filter(isLowerBound).map((cell) => ({ readSet: cell.readSet, position: cell.position }));
  const stoppedAtBaseline = stopped.filter((entry) => entry.size === BASELINE_SIZE);
  return { met: overTarget.length === 0 && lowerBound.length === 0 && stoppedAtBaseline.length === 0, worstP95: worst.p95, worst: { readSet: worst.readSet, position: worst.position }, overTarget, lowerBound, stopped: stoppedAtBaseline };
}

const ms = (value: number): string => (value >= 100 ? value.toFixed(0) : value.toFixed(1));
const p95Of = (cell: Cell): string => `${isLowerBound(cell) ? 'at least ' : ''}${ms(cell.p95)}`;

const NAMES: Readonly<Record<ReadSet, string>> = {
  dated: 'stored, dated (one relationship type with an ID and a time)',
  undated: 'stored, undated (one type with an ID and no time)',
  aggregate: 'aggregate (one type with no ID, dated; ten relationships to each neighbor, read as one row per neighbor)',
  plain: 'plain (one type with no ID and no time; one relationship to each neighbor, the shape of the banking demo pack\'s 100,000-neighbor node)',
  all: 'all four types together (the read of "expand neighbors" for one neighbor type)',
};

export function renderRecord(data: RunData): string {
  const verdict = verdictOf(data.cells, data.stopped);
  const heaviest = data.profiles.filter((profile) => profile.size === BASELINE_SIZE).reduce<Profile | undefined>((best, profile) => (best === undefined || profile.dbHits > best.dbHits ? profile : best), undefined);
  const sizes = [...new Set(data.cells.map((cell) => cell.size))];
  const sets = [...new Set(data.cells.map((cell) => cell.readSet))];
  const lines: string[] = [
    '# Supernode benchmark',
    '',
    'The cost of one page of the paged expand (`POST /v1/graph/expand`, template `expand-neighbors`) and of the degree preview, on a node of 1,000, 10,000 and 100,000 relationships of each type, measured through the gate against a Neo4j server. Synthetic data only. Written by `pnpm bench:supernode`; the numbers are in [supernode.json](supernode.json).',
    '',
    '## What a page costs the server',
    '',
    'Each page still matches every relationship of the anchor for the asked type before it sorts and cuts. The statement matches all of them in each of its branches, orders them, and keeps the page and one row, so the work of a page grows with the number of relationships of the type on the node, whichever page is asked; the keyset cursor only decides which rows survive the cut. (TAS §8.2, "What keyset buys, honestly".)',
    '',
    'The statement the gate renders has several branches, each of which matches the relationships of its type again (the profile tables give the count and the server\'s own db hits for each read set, size and position).',
    '',
    '## How it was measured',
    '',
    ...(data.commit === undefined ? [] : [`- Run on the code of commit ${data.commit}${data.note === undefined ? '' : `, ${data.note}`}.`]),
    `- Neo4j ${data.neo4j.version} (${data.neo4j.edition}); run on ${data.date}. The server's address ${data.serverIsLoopback ? 'is' : 'is not'} a loopback address. One benchmark process, one request at a time, no other load that the run made.`,
    `- One anchor per size, each with the same number of relationships of four types to one neighbor type: *dated* (an ID and a time), *undated* (an ID, no time), *aggregate* (no ID, a time, ${MEMBERS_PER_NEIGHBOR} relationships to each neighbor, read as one row per neighbor) and *plain* (no ID, no time, one relationship to each neighbor: the shape of the banking demo pack's 100,000-neighbor node, which is not loaded itself). *All* asks for the four together, as "expand neighbors" does for one neighbor type: at size 100,000 that is 400,000 relationships to 100,000 neighbors. "100k" below is the size 100,000 of every read set.`,
    `- Page size ${PAGE}, the product's default. Time is the wall time of the gate call (resolve, validate, authorize, execute, normalize, redact, audit, with the driver and the network), in milliseconds. Budgets are the source's defaults (5 s read timeout, 10 s request).`,
    `- Positions: the first page, and the pages from 10 %, 50 % and 90 % of the order (rounded down to a multiple of 50 rows). A deep position is reached by walking the real chain of cursors the gate minted, at page size 50 and untimed, and its samples are taken as soon as the walk reaches it. At each position ${SAMPLES_PER_POSITION} consecutive pages are timed; if the order ends first, the position's page is requested again and *Repeated* says how many times.`,
    '- p95 is nearest rank: the smallest value that at least 95 % of the samples do not exceed (the 29th of 30). A call that fails (a timeout, a busy source) is a sample as long as the call took and is counted in *Failures*; a cell whose failures are over 5 % of its samples shows "at least", since a failed call\'s real length is not known.',
    '- Before each read set, 5 untimed pages warm it. The very first request of the run is reported on its own and kept out of the cells.',
    `- The cold first request took ${ms(data.cold.ms)} ms${data.cold.failed ? ' and failed' : ''}.`,
    '- The db hits and the server times come from one profiled run of the statement at each position, on a separate session; profiling adds cost of its own, so they are not comparable with the timed samples and a server time can exceed a wall-time p95.',
    '- The walk fails the run on a repeated edge or on a page that is short before the last. The profile of each position runs the rendered statement once under PROFILE on a separate session and fails the run if the plan does not start from the stable ID index.',
    '',
    '## Result',
    '',
    verdict.met
      ? `**Target met.** The worst p95 at 100,000 relationships is ${ms(verdict.worstP95)} ms (${verdict.worst.readSet}, ${verdict.worst.position}), under 3,000 ms (TAS §14, interactive latency).`
      : verdict.overTarget.length > 0
        ? `**Target not met.** p95 at 100,000 relationships is 3,000 ms or more for: ${verdict.overTarget.map((cell) => `${cell.readSet} at ${cell.position} (${ms(cell.p95)} ms)`).join('; ')}. The worst is ${ms(verdict.worstP95)} ms (${verdict.worst.readSet}, ${verdict.worst.position}). What would fix it is a cheaper read, one that does not match every relationship of the anchor for each page${heaviest === undefined ? '' : `; the heaviest statement at 100,000 is ${heaviest.readSet} at ${heaviest.position}, ${heaviest.dbHits.toLocaleString('en-US')} db hits over ${heaviest.branches} branches`}. That fix is not part of this benchmark.`
        : '**Target not shown.** Every p95 at 100,000 that was measured is under 3,000 ms, but the figure is not complete: see the cells and walks listed below.',
    ...(verdict.lowerBound.length === 0 ? [] : ['', `Cells at 100,000 whose p95 is "at least" (failures over 5 %): ${verdict.lowerBound.map((cell) => `${cell.readSet} at ${cell.position}`).join('; ')}.`]),
    ...(data.stopped.length === 0 ? [] : ['', 'Walks that could not pass a row, with the positions they did not reach:', ...data.stopped.map((entry) => `- ${entry.readSet} at ${entry.size.toLocaleString('en-US')}: stopped at row ${entry.atRow.toLocaleString('en-US')}; not reached: ${entry.notReached.join(', ')}.`)]),
    '',
  ];
  for (const set of sets) {
    lines.push(`### ${NAMES[set]}`, '', '| Relationships | Position | Rows in the order | Samples | Failures | Repeated | p50 (ms) | p95 (ms) | max (ms) | Branches | db hits | Server ms (to first record / then to last) |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const size of sizes) {
      for (const cell of data.cells.filter((entry) => entry.readSet === set && entry.size === size)) {
        const profile = data.profiles.find((entry) => entry.size === size && entry.readSet === set && entry.position === cell.position);
        lines.push(`| ${size.toLocaleString('en-US')} | ${cell.position} | ${cell.rows.toLocaleString('en-US')} | ${cell.samples} | ${cell.failures} | ${cell.repeated} | ${ms(cell.p50)} | ${p95Of(cell)} | ${ms(cell.max)} | ${profile?.branches ?? ''} | ${profile?.dbHits.toLocaleString('en-US') ?? ''} | ${profile === undefined ? '' : `${profile.availableMs} / ${profile.consumedMs}`} |`);
      }
    }
    lines.push('');
  }
  lines.push('### Degree preview (bounded read)', '', '| Relationships | Count labels | Samples | Failures | p50 (ms) | p95 (ms) | max (ms) |', '|---|---|---|---|---|---|---|');
  for (const preview of data.previews) lines.push(`| ${preview.size.toLocaleString('en-US')} | ${preview.quality} | ${preview.samples} | ${preview.failures} | ${ms(preview.p50)} | ${ms(preview.p95)} | ${ms(preview.max)} |`);
  lines.push('', '## Not measured', '', '- Neo4j 2026.x and other editions: only the dev server was measured. A 2026.x run needs the series check of the test helper (`testing/neo4j-server.ts`) widened and a server of that series.', `- The banking demo pack's own node (the plain read set has its shape and size), concurrent readers, ${data.serverIsLoopback ? 'a remote server, ' : ''}a cold server, the cost of a cancelled read and the CI supernode suite.`, '');
  return lines.join('\n');
}
