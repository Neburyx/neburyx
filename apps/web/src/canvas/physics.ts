import type { Position } from '../state/presentation-state.js';
import { IDEAL_LENGTH, PHYSICS_ALPHA_DECAY, PHYSICS_ALPHA_MIN, PHYSICS_DAMPING, PHYSICS_MAX_TRAVEL, PHYSICS_REHEAT, PHYSICS_PUSH, PHYSICS_REST_FRAMES, PHYSICS_REST_SPEED, REPULSION_REACH } from './layout-constants.js';

export interface PhysicsInput {
  readonly ids: readonly string[];
  readonly links: readonly (readonly [string, string])[];
  readonly positions: ReadonlyMap<string, Position>;
  /** Entities that never move. */
  readonly pinned: ReadonlySet<string>;
}

export interface PhysicsModel {
  /** Moves every free entity one frame; returns the speed of the fastest. */
  step(): number;
  /** True once the fastest entity has been below the rest speed for several frames in a row. */
  readonly settled: boolean;
  position(id: string): Position | undefined;
  positions(): Map<string, Position>;
  /** Holds an entity at a place (it is being dragged): it exerts its force and does not move. */
  hold(id: string, at: Position): void;
  release(id: string): void;
  /** Puts an entity somewhere the model did not take it, and wakes it. */
  moveTo(id: string, at: Position): void;
  has(id: string): boolean;
  /** How many entities the model holds. */
  readonly size: number;
}

const CELL = REPULSION_REACH;
const cellKey = (x: number, y: number): number => Math.floor(x / CELL) * 100_003 + Math.floor(y / CELL);

/**
 * A damped spring model of the force layout: a relationship pulls its two ends toward the ideal length, entities within reach push each other apart, and pinned or held entities do not move.
 * Nothing is random: two entities at the same spot are pushed apart by their order.
 */
export function createPhysics({ ids, links, positions, pinned }: PhysicsInput): PhysicsModel {
  const count = ids.length;
  const at = new Map(ids.map((id, index) => [id, index]));
  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  const fixed = new Uint8Array(count);
  ids.forEach((id, index) => {
    const position = positions.get(id);
    xs[index] = position?.x ?? 0;
    ys[index] = position?.y ?? 0;
    if (pinned.has(id)) fixed[index] = 1;
  });
  const pairs: number[] = [];
  const seen = new Set<number>();
  for (const [from, to] of links) {
    const a = at.get(from);
    const b = at.get(to);
    if (a === undefined || b === undefined || a === b) continue;
    const low = Math.min(a, b);
    const high = Math.max(a, b);
    const id = low * count + high;
    if (seen.has(id)) continue;
    seen.add(id);
    pairs.push(low, high);
  }
  const held = new Set<number>();
  let calm = 0;
  // The forces cool: a disturbance starts them at the reheat strength and they fall to nothing, so the loop always ends.
  let alpha = PHYSICS_REHEAT;
  const reach = REPULSION_REACH * REPULSION_REACH;
  const squared = IDEAL_LENGTH * IDEAL_LENGTH;

  const model: PhysicsModel = {
    get settled() {
      return calm >= PHYSICS_REST_FRAMES || alpha < PHYSICS_ALPHA_MIN;
    },
    step() {
      fx.fill(0);
      fy.fill(0);
      const cells = new Map<number, number[]>();
      for (let index = 0; index < count; index += 1) {
        const key = cellKey(xs[index] ?? 0, ys[index] ?? 0);
        const held_ = cells.get(key);
        if (held_ === undefined) cells.set(key, [index]);
        else held_.push(index);
      }
      for (let index = 0; index < count; index += 1) {
        const x = xs[index] ?? 0;
        const y = ys[index] ?? 0;
        const cx = Math.floor(x / CELL);
        const cy = Math.floor(y / CELL);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (const other of cells.get((cx + dx) * 100_003 + (cy + dy)) ?? []) {
              if (other <= index) continue;
              let gapX = x - (xs[other] ?? 0);
              let gapY = y - (ys[other] ?? 0);
              let apart = gapX * gapX + gapY * gapY;
              if (apart > reach) continue;
              if (apart < 1) {
                gapX = (other - index) % 2 === 0 ? 1 : -1;
                gapY = 1;
                apart = 2;
              }
              const push = squared / apart;
              fx[index] = (fx[index] ?? 0) + gapX * push;
              fy[index] = (fy[index] ?? 0) + gapY * push;
              fx[other] = (fx[other] ?? 0) - gapX * push;
              fy[other] = (fy[other] ?? 0) - gapY * push;
            }
          }
        }
      }
      for (let pair = 0; pair < pairs.length; pair += 2) {
        const a = pairs[pair] ?? 0;
        const b = pairs[pair + 1] ?? 0;
        const gapX = (xs[a] ?? 0) - (xs[b] ?? 0);
        const gapY = (ys[a] ?? 0) - (ys[b] ?? 0);
        const pull = Math.hypot(gapX, gapY) / IDEAL_LENGTH;
        fx[a] = (fx[a] ?? 0) - gapX * pull;
        fy[a] = (fy[a] ?? 0) - gapY * pull;
        fx[b] = (fx[b] ?? 0) + gapX * pull;
        fy[b] = (fy[b] ?? 0) + gapY * pull;
      }
      alpha *= PHYSICS_ALPHA_DECAY;
      let fastest = 0;
      for (let index = 0; index < count; index += 1) {
        if (fixed[index] === 1 || held.has(index)) {
          vx[index] = 0;
          vy[index] = 0;
          continue;
        }
        let nx = ((vx[index] ?? 0) + (fx[index] ?? 0) * PHYSICS_PUSH * alpha) * PHYSICS_DAMPING;
        let ny = ((vy[index] ?? 0) + (fy[index] ?? 0) * PHYSICS_PUSH * alpha) * PHYSICS_DAMPING;
        const speed = Math.hypot(nx, ny);
        if (speed > PHYSICS_MAX_TRAVEL) {
          nx = (nx / speed) * PHYSICS_MAX_TRAVEL;
          ny = (ny / speed) * PHYSICS_MAX_TRAVEL;
        }
        vx[index] = nx;
        vy[index] = ny;
        xs[index] = (xs[index] ?? 0) + nx;
        ys[index] = (ys[index] ?? 0) + ny;
        fastest = Math.max(fastest, Math.min(speed, PHYSICS_MAX_TRAVEL));
      }
      calm = fastest < PHYSICS_REST_SPEED ? calm + 1 : 0;
      return fastest;
    },
    position(id) {
      const index = at.get(id);
      return index === undefined ? undefined : { x: xs[index] ?? 0, y: ys[index] ?? 0 };
    },
    positions() {
      return new Map(ids.map((id, index) => [id, { x: xs[index] ?? 0, y: ys[index] ?? 0 }] as const));
    },
    hold(id, place) {
      const index = at.get(id);
      if (index === undefined) return;
      held.add(index);
      xs[index] = place.x;
      ys[index] = place.y;
      calm = 0;
      alpha = PHYSICS_REHEAT;
    },
    release(id) {
      const index = at.get(id);
      if (index !== undefined) held.delete(index);
      calm = 0;
      alpha = PHYSICS_REHEAT;
    },
    moveTo(id, place) {
      const index = at.get(id);
      if (index === undefined) return;
      xs[index] = place.x;
      ys[index] = place.y;
      vx[index] = 0;
      vy[index] = 0;
      calm = 0;
      alpha = PHYSICS_REHEAT;
    },
    has: (id) => at.has(id),
    size: count,
  };
  return model;
}
