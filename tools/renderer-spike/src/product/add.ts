import { z } from 'zod';
import { frameStatistics } from '../measure/frame-stats.js';
import { MeasureError } from '../measure/errors.js';
import { writeFileOnce } from '../measure/report.js';
import { RunnerError } from '../runner/errors.js';
import { EXPECTED_ELEMENTS, type Readout } from './checks.js';

/** The target recorded with the renderer decision for adding 25 entities at 300 elements, with the CPU slowed 4x: no frame longer than 100 ms and, over the next 30 frames, at least 30 fps at the 5th percentile. */
export const ADD_TARGET = { cpuThrottle: 4, longestFrameMs: 100, p5Fps: 30, framesAfter: 30 } as const;

/** What the app's development control adds: 25 entities, each joined by one relationship to an entity that is loaded (the app's own tests hold the loader to these numbers). */
export const EXPECTED_ADDED = { entities: 25, relationships: 25 } as const;

export const ADD_RUNS = 3;

/** What one add left on the page, read from the app's own read-out and from the frames. */
export interface AddCapture {
  /** Frame times from the last frame before the control was pressed to the last of the 30 frames after the one that showed the add drawn. */
  readonly times: readonly number[];
  /** The index in `times` of the frame that showed the add drawn: the 30 frames the rates are taken over follow it. */
  readonly drawnAt: number;
  readonly before: Readout | undefined;
  readonly after: Readout | undefined;
  /** How many entities the mark held, and how many of them were drawn elsewhere afterwards, the pinned and the unpinned apart; undefined when the canvas carries no mark. */
  readonly marked: number | undefined;
  readonly movedPinned: number | undefined;
  readonly movedUnpinned: number | undefined;
  readonly notice: string | undefined;
}

export interface AddRun {
  readonly addedEntities: number;
  readonly addedRelationships: number;
  readonly longestFrameMs: number;
  readonly frames: number;
  readonly medianFps: number;
  readonly p5Fps: number;
  readonly movedPinned: number;
  readonly movedUnpinned: number;
}

export interface FrameFigures {
  readonly longestFrameMs: number;
  readonly frames: number;
  readonly medianFps: number;
  readonly p5Fps: number;
}

/** The longest frame from the last frame before the action to the end of the window, and the rates over exactly the 30 frames that follow the frame that showed the action drawn; frame times that are too few, do not rise or are not numbers are refused. */
export function frameFigures(times: readonly number[], drawnAt: number): FrameFigures {
  const end = drawnAt + 1 + ADD_TARGET.framesAfter;
  if (!Number.isInteger(drawnAt) || drawnAt < 0 || times.length < end || times.some((time, index) => !Number.isFinite(time) || (index > 0 && time <= (times[index - 1] ?? 0)))) throw new RunnerError('FRAMES_INVALID', `${times.length} frame times, the action drawn at ${drawnAt}`);
  let longest = 0;
  for (let index = 1; index < end; index += 1) longest = Math.max(longest, (times[index] ?? 0) - (times[index - 1] ?? 0));
  try {
    const { frames, medianFps, p5Fps } = frameStatistics(times.slice(drawnAt, end));
    return { longestFrameMs: longest, frames, medianFps, p5Fps };
  } catch (error) {
    if (error instanceof MeasureError) throw new RunnerError('FRAMES_INVALID', error.code);
    throw error;
  }
}

/** A number of entities: finite, whole and not below zero. */
export function entityCount(value: number | undefined, what: string): number {
  if (value === undefined || !Number.isInteger(value) || value < 0) throw new RunnerError('MARK_MISSING', `${what} is ${value ?? 'missing'}, a count of entities was expected`);
  return value;
}

/** The checks that tell an add that happened from one that did not, made on every run before its figures are taken. */
export function checkAdd(capture: AddCapture): AddRun {
  const { before, after } = capture;
  if (before === undefined || after === undefined) throw new RunnerError('CANVAS_MISSING');
  if (capture.notice !== undefined) throw new RunnerError('RENDERER_FAILED', capture.notice);
  const drawnBefore = before.entities + before.relationships;
  if (drawnBefore !== EXPECTED_ELEMENTS) throw new RunnerError('PARTIAL_DRAW', `${before.entities} entities and ${before.relationships} relationships drawn before the add, ${EXPECTED_ELEMENTS} elements expected`);
  const addedEntities = after.entities - before.entities;
  const addedRelationships = after.relationships - before.relationships;
  if (addedEntities !== EXPECTED_ADDED.entities || addedRelationships !== EXPECTED_ADDED.relationships) {
    throw new RunnerError('PARTIAL_ADD', `${addedEntities} entities and ${addedRelationships} relationships were drawn by the add, ${EXPECTED_ADDED.entities} and ${EXPECTED_ADDED.relationships} expected`);
  }
  const marked = entityCount(capture.marked, 'the mark');
  const movedPinned = entityCount(capture.movedPinned, 'the pinned entities that moved');
  const movedUnpinned = entityCount(capture.movedUnpinned, 'the unpinned entities that moved');
  if (marked !== before.entities) throw new RunnerError('MARK_MISSING', `${marked} entities marked, ${before.entities} expected`);
  if (movedPinned + movedUnpinned > 0) throw new RunnerError('ENTITY_MOVED', `${movedUnpinned} unpinned and ${movedPinned} pinned entities were drawn elsewhere after the add`);
  const figures = frameFigures(capture.times, capture.drawnAt);
  return { addedEntities, addedRelationships, ...figures, movedPinned, movedUnpinned };
}

export type AddVerdict = 'met' | 'not-met' | 'not-applicable';

/** The target is defined for the 4x run, so a run with less throttle records its figures and gives no verdict. */
export function evaluateAdd(runs: readonly Pick<AddRun, 'longestFrameMs' | 'p5Fps'>[], cpuThrottle: number): AddVerdict {
  if (cpuThrottle < ADD_TARGET.cpuThrottle) return 'not-applicable';
  return runs.every((run) => run.longestFrameMs <= ADD_TARGET.longestFrameMs && run.p5Fps >= ADD_TARGET.p5Fps) ? 'met' : 'not-met';
}

const runSchema = z.strictObject({
  addedEntities: z.number().int().positive(),
  addedRelationships: z.number().int().nonnegative(),
  longestFrameMs: z.number().positive(),
  frames: z.number().int().positive(),
  medianFps: z.number().positive(),
  p5Fps: z.number().positive(),
  movedPinned: z.number().int().nonnegative().refine((count) => count < 1, 'no entity may have moved'),
  movedUnpinned: z.number().int().nonnegative().refine((count) => count < 1, 'no entity may have moved'),
});

export const addReportSchema = z.strictObject({
  status: z.literal('complete'),
  target: z.literal('product'),
  scenario: z.literal('add'),
  measuredAt: z.iso.datetime(),
  app: z.strictObject({ origin: z.string().min(1), drawnEntities: z.number().int().positive(), drawnRelationships: z.number().int().positive() }),
  browser: z.strictObject({ name: z.string().min(1), version: z.string().min(1), headed: z.boolean() }),
  os: z.strictObject({ platform: z.string().min(1), release: z.string().min(1), arch: z.string().min(1) }),
  cpu: z.strictObject({ model: z.string().min(1), cores: z.number().int().positive() }),
  viewport: z.strictObject({ width: z.number().int().positive(), height: z.number().int().positive(), devicePixelRatio: z.number().positive() }),
  protocol: z.strictObject({ runs: z.number().int().positive(), framesAfter: z.number().int().positive(), cpuThrottle: z.number().int().min(1) }),
  runs: z.array(runSchema).min(1),
  goal: z.strictObject({ cpuThrottle: z.literal(ADD_TARGET.cpuThrottle), longestFrameMs: z.literal(ADD_TARGET.longestFrameMs), p5Fps: z.literal(ADD_TARGET.p5Fps) }),
  verdict: z.enum(['met', 'not-met', 'not-applicable']),
});

export type AddReport = z.infer<typeof addReportSchema>;

/** Writes the report only if it is complete; the file appears all at once or not at all. */
export function writeAddReport(path: string, report: unknown): AddReport {
  const parsed = addReportSchema.safeParse(report);
  if (!parsed.success) throw new MeasureError('REPORT_INVALID');
  writeFileOnce(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}
