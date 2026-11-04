import { z } from 'zod';
import { MeasureError } from '../measure/errors.js';
import { writeFileOnce } from '../measure/report.js';
import { RunnerError } from '../runner/errors.js';
import { ADD_TARGET, entityCount, frameFigures, type FrameFigures } from './add.js';
import { EXPECTED_ELEMENTS, type Readout } from './checks.js';

/** What the app's development control "Displace 10 entities" does before the layout run: ten unpinned entities are put far from the rest. */
export const DISPLACED = 10;

/** What one layout run left on the page, read from the app's own read-out and from the frames. */
export interface LayoutCapture {
  /** Frame times from the last frame before the control was pressed to the last of the 30 frames after the one that showed the run drawn. */
  readonly times: readonly number[];
  /** The index in `times` of the frame that showed the run drawn. */
  readonly drawnAt: number;
  /** What the displacement step did, against a mark made before it: how many entities, pinned and unpinned, were drawn elsewhere afterwards, and which. */
  readonly displaced: { readonly movedPinned: number | undefined; readonly movedUnpinned: number | undefined; readonly ids: readonly string[] | undefined } | undefined;
  /** Which entities were drawn elsewhere after the layout run, against the mark made after the displacement. */
  readonly movedIds: readonly string[] | undefined;
  readonly before: Readout | undefined;
  readonly after: Readout | undefined;
  /** How many entities the mark held (made after the displacement), and how many were drawn elsewhere after the run, the pinned and the unpinned apart. */
  readonly marked: number | undefined;
  readonly movedPinned: number | undefined;
  readonly movedUnpinned: number | undefined;
  /** How long the command itself took, from the press that chose it to the end of that press's own work. */
  readonly commandMs: number;
  readonly notice: string | undefined;
}

export interface LayoutRun extends FrameFigures {
  readonly displaced: number;
  readonly movedPinned: number;
  readonly movedUnpinned: number;
  readonly commandMs: number;
}

/** The ids the app's read-out lists, or undefined when it lists none or something that is not a list of text. */
export function parseIds(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const sameView = (before: Readout, after: Readout): boolean => before.zoom === after.zoom && before.panX === after.panX && before.panY === after.panY;

/** The checks that tell a layout run that happened from one that did not, made on every run before its figures are taken. */
export function checkLayout(capture: LayoutCapture): LayoutRun {
  const { before, after } = capture;
  if (before === undefined || after === undefined) throw new RunnerError('CANVAS_MISSING');
  if (capture.notice !== undefined) throw new RunnerError('RENDERER_FAILED', capture.notice);
  if (before.entities + before.relationships !== EXPECTED_ELEMENTS) throw new RunnerError('PARTIAL_DRAW', `${before.entities} entities and ${before.relationships} relationships drawn before the layout, ${EXPECTED_ELEMENTS} elements expected`);
  if (after.entities !== before.entities || after.relationships !== before.relationships) throw new RunnerError('PARTIAL_DRAW', `${after.entities} entities and ${after.relationships} relationships drawn after the layout`);
  const { displaced } = capture;
  if (displaced === undefined) throw new RunnerError('DISPLACEMENT_FAILED', 'no read-out of the displacement');
  const displacedPinned = entityCount(displaced.movedPinned, 'the pinned entities the displacement moved');
  const displacedUnpinned = entityCount(displaced.movedUnpinned, 'the unpinned entities the displacement moved');
  const displacedIds = displaced.ids;
  if (displacedIds === undefined || displacedPinned !== 0 || displacedUnpinned !== DISPLACED || displacedIds.length !== DISPLACED) throw new RunnerError('DISPLACEMENT_FAILED', `${displacedUnpinned} unpinned and ${displacedPinned} pinned entities moved, ${DISPLACED} unpinned and none pinned expected`);
  const marked = entityCount(capture.marked, 'the mark');
  const movedPinned = entityCount(capture.movedPinned, 'the pinned entities that moved');
  const movedUnpinned = entityCount(capture.movedUnpinned, 'the unpinned entities that moved');
  if (marked !== before.entities || capture.movedIds === undefined) throw new RunnerError('MARK_MISSING', `${marked} entities marked, ${before.entities} expected`);
  if (movedPinned > 0) throw new RunnerError('PIN_MOVED', `${movedPinned} pinned entities were drawn elsewhere after the layout`);
  const moved = new Set(capture.movedIds);
  const stayed = displacedIds.filter((id) => !moved.has(id));
  if (stayed.length > 0) throw new RunnerError('LAYOUT_INEFFECTIVE', `${stayed.length} of the ${DISPLACED} displaced entities were not moved by the layout`);
  if (!sameView(before, after)) throw new RunnerError('VIEW_CHANGED', `the zoom or the pan changed (${before.zoom}, ${before.panX}, ${before.panY} to ${after.zoom}, ${after.panX}, ${after.panY})`);
  if (!Number.isFinite(capture.commandMs) || capture.commandMs < 0) throw new RunnerError('FRAMES_INVALID', 'the command time');
  return { displaced: DISPLACED, movedPinned, movedUnpinned, commandMs: capture.commandMs, ...frameFigures(capture.times, capture.drawnAt) };
}

const runSchema = z.strictObject({
  displaced: z.number().int().positive(),
  movedPinned: z.number().int().nonnegative().refine((count) => count < 1, 'no entity may have moved'),
  movedUnpinned: z.number().int().min(DISPLACED),
  commandMs: z.number().nonnegative(),
  longestFrameMs: z.number().positive(),
  frames: z.number().int().positive(),
  medianFps: z.number().positive(),
  p5Fps: z.number().positive(),
});

export const layoutReportSchema = z.strictObject({
  status: z.literal('complete'),
  target: z.literal('product'),
  scenario: z.literal('layout'),
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

export type LayoutReport = z.infer<typeof layoutReportSchema>;

/** Writes the report only if it is complete; the file appears all at once or not at all. */
export function writeLayoutReport(path: string, report: unknown): LayoutReport {
  const parsed = layoutReportSchema.safeParse(report);
  if (!parsed.success) throw new MeasureError('REPORT_INVALID');
  writeFileOnce(path, `${JSON.stringify(parsed.data, null, 2)}\n`);
  return parsed.data;
}
