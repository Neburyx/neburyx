import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { ClientState } from '../state/client-state.js';
import type { Position } from '../state/presentation-state.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { PhysicsLoop, type Clock, type Follower } from './physics-loop.js';
import type { CanvasRenderer, Scene } from './scene.js';

export const browserClock: Clock = {
  request: (frame) => requestAnimationFrame(frame),
  cancel: (handle) => cancelAnimationFrame(handle),
  visible: () => document.visibilityState !== 'hidden',
  now: () => performance.now(),
};

interface UsePhysics {
  readonly state: ClientState;
  readonly renderer: CanvasRenderer | undefined;
  /** Physics is on, the layout is Force, and nothing has failed. */
  readonly enabled: boolean;
  readonly graph: LoadedGraph;
  readonly pins: ReadonlySet<string>;
  readonly scene: Scene;
  readonly onFailure: () => void;
  readonly clock?: Clock;
  /** Holds the running loop, so that the drawing's drag events can reach it. */
  readonly loopRef: MutableRefObject<PhysicsLoop | undefined>;
}

function graphOf(scene: Scene, pinned: ReadonlySet<string>) {
  const positions = new Map<string, Position>();
  const remainders = new Map<string, Position>();
  for (const entity of scene.entities) (entity.remainder === true ? remainders : positions).set(entity.id, entity.position);
  const links: [string, string][] = [];
  const followers: Follower[] = [];
  for (const relationship of scene.relationships) {
    if (relationship.remainder !== true) {
      links.push([relationship.from, relationship.to]);
      continue;
    }
    const aggregate = remainders.has(relationship.from) ? relationship.from : relationship.to;
    const owner = aggregate === relationship.from ? relationship.to : relationship.from;
    const from = remainders.get(aggregate);
    const at = positions.get(owner);
    if (from !== undefined && at !== undefined) followers.push({ id: aggregate, owner, offset: { x: from.x - at.x, y: from.y - at.y } });
  }
  return { ids: [...positions.keys()], links, positions, pinned, followers };
}

/** Runs the live force layout while it is enabled; returns the loop so that the canvas can tell it about drags. */
export function usePhysics({ state, renderer, enabled, graph, pins, scene, onFailure, clock = browserClock, loopRef }: UsePhysics): void {
  const [loop, setLoop] = useState<PhysicsLoop | undefined>(undefined);
  const latest = useRef(scene);
  latest.current = scene;
  const failure = useRef(onFailure);
  failure.current = onFailure;

  useEffect(() => {
    if (!enabled || renderer === undefined) return undefined;
    const store = (given: ReadonlyMap<string, Position>): void => {
      const held = state.presentation.view.getState().positions;
      const positions = new Map([...given].filter(([id, place]) => held.get(id)?.x !== place.x || held.get(id)?.y !== place.y));
      if (positions.size === 0) return;
      try {
        state.presentation.setPositions(positions);
      } catch {
        // an entity that is gone has nothing to store
      }
    };
    const made = new PhysicsLoop(
      {
        place: (positions) => renderer.placeLive(positions),
        commit: (positions) => {
          store(positions);
          renderer.endLive();
        },
        failed: (lastDrawn) => {
          try {
            renderer.placeLive(lastDrawn);
          } catch {
            // the drawing is what failed; the notice says so
          }
          renderer.endLive();
          store(lastDrawn);
          failure.current();
        },
      },
      clock,
    );
    const onVisibility = (): void => made.visibility();
    document.addEventListener('visibilitychange', onVisibility);
    loopRef.current = made;
    setLoop(made);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      made.stop();
      if (loopRef.current === made) loopRef.current = undefined;
      setLoop(undefined);
    };
  }, [enabled, renderer, state, clock, loopRef]);

  const structure = scene.entities.length + scene.relationships.length;
  useEffect(() => {
    loop?.configure(graphOf(latest.current, pins));
  }, [loop, graph, pins, structure]);

  useEffect(() => {
    if (loop === undefined) return undefined;
    let previous = state.presentation.view.getState().positions;
    return state.presentation.view.subscribe(() => {
      const next = state.presentation.view.getState().positions;
      if (next === previous) return;
      const changed = new Map<string, Position>();
      for (const [id, place] of next) {
        const was = previous.get(id);
        if (was === undefined || was.x !== place.x || was.y !== place.y) changed.set(id, place);
      }
      previous = next;
      if (changed.size > 0) loop.external(changed);
    });
  }, [loop, state]);

}
