import { z } from 'zod';
import type { Position, RendererAdapter } from '../adapter.js';
import { generateAdditions } from '../fixture/generate.js';
import { createRandom, type Random } from '../fixture/random.js';
import type { Fixture } from '../fixture/schema.js';
import type { Clock } from './clock.js';
import { MeasureError } from './errors.js';
import { frameStatistics } from './frame-stats.js';

export const MANUAL_NODES = 20;
export const PINNED_NODES = 10;
export const FRAMES_AFTER_ADD = 30;

const MIN_MANUAL_SHIFT = 50;
const MANUAL_SHIFT_RANGE = 100;
const FULL_TURN = Math.PI * 2;

const movedGroupSchema = z.strictObject({
  total: z.number().int().nonnegative(),
  moved: z.number().int().nonnegative(),
  medianDisplacement: z.number().nonnegative(),
  maxDisplacement: z.number().nonnegative(),
});

export const incrementalResultSchema = z.strictObject({
  holdMechanism: z.string().min(1),
  addedNodes: z.number().int().positive(),
  drawnBefore: z.number().int().positive(),
  drawnAfter: z.number().int().positive(),
  addDurationMs: z.number().nonnegative(),
  frames: z.strictObject({ frames: z.number().int().positive(), medianFps: z.number().positive(), p5Fps: z.number().positive() }),
  longestFrameMs: z.number().positive(),
  manual: movedGroupSchema,
  pinned: movedGroupSchema,
  unpinned: movedGroupSchema,
});

export type MovedGroup = z.infer<typeof movedGroupSchema>;
export type IncrementalResult = z.infer<typeof incrementalResultSchema>;

function distance(first: Position, second: Position): number {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? 0) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function collectFrames(clock: Clock, count: number, atFirstFrame: () => void): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const timestamps: number[] = [];
    const onFrame = (time: number): void => {
      try {
        timestamps.push(time);
        if (timestamps.length === 1) atFirstFrame();
        if (timestamps.length > count) resolve(timestamps);
        else clock.nextFrame(onFrame);
      } catch (error) {
        reject(error);
      }
    };
    clock.nextFrame(onFrame);
  });
}

/** A node moved when either coordinate differs, with no tolerance; displacement figures describe the nodes that moved. */
export function compareMoves(before: ReadonlyMap<string, Position>, after: ReadonlyMap<string, Position>, ids: readonly string[]): MovedGroup {
  const displacements: number[] = [];
  for (const id of ids) {
    const first = before.get(id);
    const second = after.get(id);
    if (first === undefined || second === undefined) throw new MeasureError('POSITIONS_UNAVAILABLE');
    if (first.x !== second.x || first.y !== second.y) displacements.push(distance(first, second));
  }
  return { total: ids.length, moved: displacements.length, medianDisplacement: median(displacements), maxDisplacement: Math.max(0, ...displacements) };
}

function shuffled(ids: readonly string[], random: Random): string[] {
  const result = [...ids];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    const held = result[index];
    result[index] = result[other] ?? '';
    result[other] = held ?? '';
  }
  return result;
}

/** The nodes are added inside a frame, so the next frame's interval includes the time the add and its layout blocked the page (frame timestamps and `now()` are not mixed). */
export async function measureIncremental(adapter: RendererAdapter, fixture: Fixture, clock: Clock): Promise<IncrementalResult> {
  const random = createRandom(fixture.seed + 2);
  const candidates = fixture.nodes.filter((node, index) => node.kind === 'entity' && index > 0).map((node) => node.id);
  const chosen = shuffled(candidates, random);
  const manual = chosen.slice(0, MANUAL_NODES);
  const pinned = chosen.slice(MANUAL_NODES, MANUAL_NODES + PINNED_NODES);

  const start = adapter.getPositions();
  const shifted = new Map<string, Position>();
  for (const id of manual) {
    const position = start.get(id);
    if (position === undefined) throw new MeasureError('POSITIONS_UNAVAILABLE');
    const angle = random() * FULL_TURN;
    const length = MIN_MANUAL_SHIFT + random() * MANUAL_SHIFT_RANGE;
    shifted.set(id, { x: position.x + length * Math.cos(angle), y: position.y + length * Math.sin(angle) });
  }
  adapter.setPositions(shifted);
  adapter.fix([...manual, ...pinned]);

  const before = adapter.getPositions();
  const drawnBefore = adapter.describe().nodes.length;
  const additions = generateAdditions(fixture, { seed: fixture.seed });
  let addDurationMs = 0;
  const timestamps = await collectFrames(clock, FRAMES_AFTER_ADD, () => {
    const started = clock.now();
    adapter.addNodes(additions);
    addDurationMs = clock.now() - started;
  });
  const frames = frameStatistics(timestamps);
  const longestFrameMs = Math.max(...timestamps.slice(1).map((time, index) => time - (timestamps[index] ?? time)));
  const after = adapter.getPositions();
  const drawnAfter = adapter.describe().nodes.length;

  const held = new Set([...manual, ...pinned]);
  const unpinned = fixture.nodes.map((node) => node.id).filter((id) => !held.has(id));
  return {
    holdMechanism: adapter.holdMechanism,
    addedNodes: additions.nodes.length,
    drawnBefore,
    drawnAfter,
    addDurationMs,
    frames,
    longestFrameMs,
    manual: compareMoves(before, after, manual),
    pinned: compareMoves(before, after, pinned),
    unpinned: compareMoves(before, after, unpinned),
  };
}
