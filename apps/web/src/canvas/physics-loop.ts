import type { Position } from '../state/presentation-state.js';
import { PHYSICS_CHANGE_REHEAT, PHYSICS_MAX_MS, physicsStride } from './layout-constants.js';
import { createPhysics, type PhysicsInput, type PhysicsModel } from './physics.js';

/** An aggregate node follows the entity it belongs to at the offset it had. */
export interface Follower {
  readonly id: string;
  readonly owner: string;
  readonly offset: Position;
}

export interface PhysicsHost {
  /** Moves the drawn entities without storing anything; may throw when the drawing fails. */
  place(positions: ReadonlyMap<string, Position>): void;
  /** Stores the positions of the entities that moved since the last store, and lets the drawing follow the stored ones. */
  commit(positions: ReadonlyMap<string, Position>): void;
  /** The loop stopped because a frame could not be drawn; `lastDrawn` are the positions of the last frame that was. */
  failed(lastDrawn: ReadonlyMap<string, Position>): void;
}

export interface Clock {
  request(frame: () => void): number;
  cancel(handle: number): void;
  visible(): boolean;
  /** Milliseconds on a clock that only goes forward. */
  now(): number;
}

export interface PhysicsGraph extends PhysicsInput {
  readonly followers: readonly Follower[];
}

function adjacency(ids: readonly string[], links: PhysicsGraph['links']): Map<string, readonly string[]> {
  const known = new Set(ids);
  const sets = new Map<string, Set<string>>(ids.map((id) => [id, new Set()]));
  for (const [from, to] of links) {
    if (from === to || !known.has(from) || !known.has(to)) continue;
    sets.get(from)?.add(to);
    sets.get(to)?.add(from);
  }
  return new Map([...sets].map(([id, set]) => [id, [...set]]));
}

const same = (a: Position | undefined, b: Position | undefined): boolean => a !== undefined && b !== undefined && Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;

/**
 * The live force layout: a frame is computed only while something moves, never while the document is hidden, and the positions reach the stored state when the entities settle or the loop stops, not on every frame.
 */
export class PhysicsLoop {
  private model: PhysicsModel | undefined;
  private followers: readonly Follower[] = [];
  private handle: number | undefined;
  private awake = false;
  private stopped = false;
  private broken = false;
  private deadline = 0;
  private neighbours = new Map<string, readonly string[]>();
  private known = new Set<string>();
  private readonly dragged = new Set<string>();
  /** Entities let go of by a drag: they stay where they were dropped until another entity is grabbed. */
  private readonly dropped = new Set<string>();
  private stored = new Map<string, Position>();
  private lastDrawn = new Map<string, Position>();

  constructor(private readonly host: PhysicsHost, private readonly clock: Clock) {}

  /** Frames computed since the loop was made; the tests and the measurement read it. */
  frames = 0;

  get running(): boolean {
    return this.handle !== undefined;
  }

  /** The entities or the relationships or the pins changed: the model is rebuilt from where the entities are now. */
  configure(graph: PhysicsGraph): void {
    for (const id of graph.pinned) {
      this.dragged.delete(id);
      this.dropped.delete(id);
    }
    const now = this.model?.positions();
    const positions = new Map(graph.positions);
    if (now !== undefined) for (const id of graph.ids) if (this.model?.has(id) === true && !graph.pinned.has(id)) positions.set(id, now.get(id) ?? positions.get(id) ?? { x: 0, y: 0 });
    const before = this.model === undefined ? undefined : { known: this.known, neighbours: this.neighbours };
    const around = adjacency(graph.ids, graph.links);
    // After a change only the entities that came, and the ones next to what came or went, move; the rest stay where they are. The first model, and one made during a drag, moves every free entity.
    let movable: Set<string> | undefined;
    if (before !== undefined && this.dragged.size === 0) {
      movable = new Set();
      const present = new Set(graph.ids);
      for (const id of graph.ids) {
        if (before.known.has(id)) continue;
        movable.add(id);
        for (const other of around.get(id) ?? []) movable.add(other);
      }
      for (const id of before.known) {
        if (present.has(id)) continue;
        for (const other of before.neighbours.get(id) ?? []) if (present.has(other)) movable.add(other);
      }
    }
    const heat = movable === undefined ? undefined : movable.size === 0 ? 0 : PHYSICS_CHANGE_REHEAT;
    this.model = createPhysics({ ids: graph.ids, links: graph.links, positions, pinned: graph.pinned, movable, heat });
    for (const id of [...this.dragged, ...this.dropped]) if (this.model.has(id)) this.model.hold(id, positions.get(id) ?? { x: 0, y: 0 });
    this.followers = graph.followers;
    this.stored = new Map(graph.positions);
    this.lastDrawn = new Map(positions);
    this.known = new Set(graph.ids);
    this.neighbours = around;
    this.stopped = this.broken;
    if (heat !== 0) {
      this.disturb();
      this.wake();
    }
  }

  /** Stored positions changed from outside the loop (a keyboard move, a drop, a layout run): the entities are put there. */
  external(changed: ReadonlyMap<string, Position>): void {
    const model = this.model;
    if (model === undefined) return;
    let any = false;
    for (const [id, place] of changed) {
      if (!model.has(id) || same(model.position(id), place)) continue;
      model.moveTo(id, place);
      model.unfreeze([id, ...(this.neighbours.get(id) ?? [])]);
      if (this.dragged.has(id) || this.dropped.has(id)) model.hold(id, place);
      this.stored.set(id, place);
      any = true;
    }
    if (!any) return;
    model.heatTo(PHYSICS_CHANGE_REHEAT);
    this.disturb();
    this.wake();
  }

  /** A drag was interrupted: the entity is back at its start and is not held. */
  cancelDrag(id: string, start: Position): void {
    this.dragged.delete(id);
    this.dropped.delete(id);
    this.model?.release(id);
    this.model?.moveTo(id, start);
    this.disturb();
    this.wake();
  }

  drag(id: string, at: Position | undefined): void {
    const model = this.model;
    if (at === undefined) {
      this.dragged.delete(id);
      this.dropped.add(id);
      this.disturb();
      this.wake();
      return;
    }
    if (!this.dragged.has(id)) {
      model?.thaw();
      for (const other of this.dropped) if (other !== id) model?.release(other);
      this.dropped.clear();
    }
    this.dragged.add(id);
    model?.hold(id, at);
    this.disturb();
    this.wake();
  }

  /** The document became visible or hidden. */
  visibility(): void {
    if (!this.clock.visible()) this.cancel();
    else this.wake();
  }

  /** Cancels the next frame and stores what the entities have now. */
  stop(): void {
    this.cancel();
    this.stopped = true;
    if (!this.broken) this.commit();
  }

  private cancel(): void {
    if (this.handle !== undefined) this.clock.cancel(this.handle);
    this.handle = undefined;
  }

  private disturb(): void {
    this.deadline = this.clock.now() + PHYSICS_MAX_MS;
  }

  private wake(): void {
    this.awake = true;
    if (this.stopped || this.model === undefined || this.handle !== undefined || !this.clock.visible()) return;
    this.handle = this.clock.request(this.frame);
  }

  private readonly frame = (): void => {
    this.handle = undefined;
    const model = this.model;
    if (model === undefined || this.stopped || !this.clock.visible()) return;
    const stride = physicsStride(model.size);
    model.step();
    this.frames += 1;
    // whatever the frame rate, the motion ends a fixed time after the last disturbance, unless an entity is being dragged
    const finished = model.settled || (this.dragged.size === 0 && this.clock.now() >= this.deadline);
    const due = this.frames % stride === 0 || finished;
    const drawn = due ? this.placed(model) : new Map<string, Position>();
    try {
      if (due) this.host.place(drawn);
    } catch {
      this.stopped = true;
      this.broken = true;
      this.host.failed(this.lastDrawn);
      return;
    }
    if (due) this.lastDrawn = new Map([...this.lastDrawn, ...drawn]);
    if (finished) {
      this.awake = false;
      this.commit();
      return;
    }
    this.handle = this.clock.request(this.frame);
  };

  private placed(model: PhysicsModel): Map<string, Position> {
    const out = new Map<string, Position>();
    for (const [id, place] of model.positions()) if (!this.dragged.has(id)) out.set(id, place);
    for (const { id, owner, offset } of this.followers) {
      const at = model.position(owner);
      if (at !== undefined) out.set(id, { x: at.x + offset.x, y: at.y + offset.y });
    }
    return out;
  }

  private commit(): void {
    const model = this.model;
    if (model === undefined) return;
    const moved = new Map<string, Position>();
    for (const [id, place] of model.positions()) if (!same(this.stored.get(id), place)) moved.set(id, place);
    if (moved.size === 0) {
      this.host.commit(moved);
      return;
    }
    for (const [id, place] of moved) this.stored.set(id, place);
    this.host.commit(moved);
  }
}
