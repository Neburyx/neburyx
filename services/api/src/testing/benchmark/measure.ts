import { performance } from 'node:perf_hooks';
import { AppError } from '../../errors.js';
import type { ExpansionPage } from '../../gate/normalize/expansion.js';
import type { Gate } from '../../gate/types.js';
import { DEGREE_PREVIEW_BOUNDED_ID } from '../../gate/templates/degree-preview.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import { gateRequest, LOCAL_PRINCIPAL } from '../gate.js';
import { hubOf } from './fixture.js';
import { PAGE, positionsOf, POSITION_FAILURES, RELATIONSHIP_OF, rowsOf, SAMPLES_PER_POSITION, WALK_FAILURES, WALK_PAGE, WARM_UP_PAGES, type Position, type ReadSet } from './plan.js';
import { summarizeSamples, type Sample, type SampleSummary } from './stats.js';

export interface Cell extends SampleSummary {
  readonly size: number;
  readonly readSet: ReadSet;
  readonly position: string;
  /** Rows the order of the read set holds. */
  readonly rows: number;
  /** Requests in this cell that asked a page again because the order ended before all the samples were taken. */
  readonly repeated: number;
}

export interface PreviewCell extends SampleSummary {
  readonly size: number;
  readonly quality: string;
}

interface PageAnswer {
  readonly edges: ExpansionPage['edges'];
  readonly hasMore: boolean;
  readonly nextCursor: string | undefined;
}

interface Attempt {
  readonly sample: Sample;
  readonly answer: PageAnswer | undefined;
}

/** The gate's answers that mean the source was slow or loaded; any other error, a refused cursor or request among them, is a fault of the benchmark. */
const SLOW_CODES: ReadonlySet<string> = new Set(['QUERY_TIMEOUT', 'SOURCE_BUSY', 'SOURCE_UNAVAILABLE']);

/** Times one call. A slow answer of the gate is an attempt with no answer; any other error is thrown. */
async function attemptOf<T>(work: () => Promise<T>): Promise<{ readonly sample: Sample; readonly value: T | undefined }> {
  const start = performance.now();
  try {
    const value = await work();
    return { sample: { ms: performance.now() - start, failed: false }, value };
  } catch (error) {
    if (error instanceof AppError && SLOW_CODES.has(error.code)) return { sample: { ms: performance.now() - start, failed: true }, value: undefined };
    throw error;
  }
}

async function pageOf(gate: Gate, size: number, set: ReadSet, limit: number, cursor: string | undefined): Promise<Attempt> {
  const relTypes = set === 'all' ? {} : { relTypes: [RELATIONSHIP_OF[set]] };
  const { sample, value } = await attemptOf(() =>
    gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: EXPAND_NEIGHBORS_ID, params: { entityType: 'hub', stableId: hubOf(size), neighborType: 'leaf', direction: 'both', sort: 'observed', ...relTypes }, limit, ...(cursor === undefined ? {} : { cursor }) })),
  );
  if (value === undefined) return { sample, answer: undefined };
  const item = value.items[0] as unknown as ExpansionPage | undefined;
  if (item === undefined || !item.anchorFound) throw new Error(`the anchor of ${size} relationships was not found`);
  return { sample, answer: { edges: item.edges, hasMore: value.hasMore, nextCursor: value.nextCursor } };
}

const keyOf = (edge: ExpansionPage['edges'][number]): string => JSON.stringify([edge.type, edge.ref]);

/** A page that is not the last must be full and must carry a cursor, and the last must carry none. */
export function checkShape(answer: PageAnswer, limit: number, where: string): void {
  if (answer.hasMore) {
    if (answer.edges.length !== limit || answer.nextCursor === undefined) throw new Error(`${where}: a page that has more returned ${answer.edges.length} of ${limit} edges`);
  } else if (answer.nextCursor !== undefined) {
    throw new Error(`${where}: the last page carries a cursor`);
  }
}

/** The cold first request of a run: it pays for the connection, the plan and the schema read, and stays out of every cell. */
export async function measureCold(gate: Gate, size: number): Promise<Sample> {
  const { sample, answer } = await pageOf(gate, size, 'dated', PAGE, undefined);
  if (answer === undefined) return sample;
  checkShape(answer, PAGE, 'the cold request');
  return sample;
}

/** Takes the samples of one position: 30 consecutive pages from the cursor, each failure kept as a sample and the page asked again, and after `POSITION_FAILURES` in a row the rest recorded as failures of that length; when the order ends first, the position's own page is asked again. */
export async function timedWindow(gate: Gate, size: number, set: ReadSet, label: string, start: string | undefined): Promise<{ readonly samples: readonly Sample[]; readonly repeated: number }> {
  const samples: Sample[] = [];
  const inWindow = new Set<string>();
  let repeated = 0;
  let inARow = 0;
  let next = start;
  while (samples.length < SAMPLES_PER_POSITION) {
    const { sample, answer } = await pageOf(gate, size, set, PAGE, next);
    samples.push(sample);
    if (answer === undefined) {
      inARow += 1;
      if (inARow >= POSITION_FAILURES) while (samples.length < SAMPLES_PER_POSITION) samples.push(sample);
      continue;
    }
    inARow = 0;
    checkShape(answer, PAGE, `${set} at ${size}, ${label}`);
    if (answer.edges.length === 0) throw new Error(`${set} at ${size}, ${label}: an empty page`);
    for (const edge of answer.edges) {
      const key = keyOf(edge);
      if (inWindow.has(key)) throw new Error(`${set} at ${size}, ${label}: an edge was returned twice`);
      inWindow.add(key);
    }
    if (answer.hasMore) next = answer.nextCursor;
    else {
      repeated += 1;
      next = start;
      inWindow.clear();
    }
  }
  return { samples, repeated };
}

export interface ReadSetResult {
  readonly cells: readonly Cell[];
  /** The row the walk could not pass, and the positions it did not reach; absent when every position was measured. */
  readonly stopped?: { readonly atRow: number; readonly notReached: readonly string[] };
}

/**
 * Measures one read set on one anchor. A real chain of pages of the walk size is read, untimed, up to the last position; each position's samples are taken as soon as the walk reaches it, from the cursor the gate minted there,
 * so no cursor is used long after it was made. A repeated edge on the walk, or a page that is short before the last, fails the run. `atPosition` runs when the walk reaches a position, with that cursor (none for the first page), just before its samples.
 */
export async function measureReadSet(gate: Gate, size: number, set: ReadSet, atPosition?: (label: string, cursor: string | undefined) => Promise<void>): Promise<ReadSetResult> {
  const rows = rowsOf(set, size);
  const positions = positionsOf(rows);
  const lastStart = Math.max(...positions.map((position) => position.startRow));
  for (let index = 0; index < WARM_UP_PAGES; index += 1) await pageOf(gate, size, set, PAGE, undefined);
  const cells: Cell[] = [];
  const seen = new Set<string>();
  let read = 0;
  let cursor: string | undefined;
  for (;;) {
    for (const position of positions.filter((entry) => entry.startRow === read)) {
      await atPosition?.(position.label, cursor);
      const { samples, repeated } = await timedWindow(gate, size, set, position.label, cursor);
      cells.push({ size, readSet: set, position: position.label, rows, repeated, ...summarizeSamples(samples) });
    }
    if (read >= lastStart) break;
    let attempt = await pageOf(gate, size, set, WALK_PAGE, cursor);
    for (let failures = 1; attempt.answer === undefined && failures < WALK_FAILURES; failures += 1) attempt = await pageOf(gate, size, set, WALK_PAGE, cursor);
    const { answer } = attempt;
    if (answer === undefined) return { cells, stopped: { atRow: read, notReached: positions.filter((position: Position) => position.startRow > read).map((position) => position.label) } };
    checkShape(answer, WALK_PAGE, `walk of ${set} at ${size}`);
    for (const edge of answer.edges) {
      const key = keyOf(edge);
      if (seen.has(key)) throw new Error(`walk of ${set} at ${size}: an edge was returned twice`);
      seen.add(key);
    }
    read += answer.edges.length;
    cursor = answer.nextCursor;
    if (!answer.hasMore) break;
  }
  if (cells.length !== positions.length) throw new Error(`${set} at ${size}: ${cells.length} of ${positions.length} positions were measured`);
  return { cells };
}

export async function measurePreview(gate: Gate, size: number): Promise<PreviewCell> {
  const samples: Sample[] = [];
  let quality = 'unknown';
  for (let index = 0; index < SAMPLES_PER_POSITION; index += 1) {
    const { sample, value } = await attemptOf(() => gate.run(gateRequest({ sourceId: 'graph', principal: LOCAL_PRINCIPAL, templateId: DEGREE_PREVIEW_BOUNDED_ID, params: { entityType: 'hub', stableId: hubOf(size) }, limit: 1 })));
    samples.push(sample);
    if (value === undefined) continue;
    const item = value.items[0] as { readonly found?: boolean; readonly counts?: readonly { readonly quality: string }[] } | undefined;
    if (item?.found !== true) throw new Error(`the anchor of ${size} relationships was not found by the preview`);
    quality = item.counts?.map((count) => count.quality).join(' / ') ?? 'unknown';
  }
  return { size, quality, ...summarizeSamples(samples) };
}
