import type { GraphEdge, Window } from '@neburyx/contracts';
import { edgeKey, elementKey } from './keys.js';
import type { LoadedGraph } from './loaded-graph.js';

const DAY_MS = 86_400_000;
const INSTANT_SHAPE = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?(?:\[[^\]]*\])?)?$/;

/** A relationship row of the mapping that has a time: its type and the entity types of its two ends. */
export interface DatedRow {
  readonly type: string;
  readonly from: string;
  readonly to: string;
}

/** The time window as set in the Filters panel, with the dated rows of the mapping it can judge. Without a dated row it filters nothing. */
export interface TimeFilter {
  readonly window: Window;
  readonly rows: readonly DatedRow[];
}

/** UTC milliseconds: `start` is in the window, `end` is not. */
export interface TimeBounds {
  readonly start: number;
  readonly end: number;
}

export const sameWindow = (a: Window, b: Window): boolean => ('days' in a ? 'days' in b && a.days === b.days : 'from' in b && a.from === b.from && a.to === b.to);

const startOfDay = (instant: number): number => Math.floor(instant / DAY_MS) * DAY_MS;

/** The window as the server reads it: `{days: n}` runs from 00:00 UTC n days before today to the end of today; `{from, to}` from 00:00 UTC of `from` to the end of `to`. */
export function boundsOf(window: Window, now: Date): TimeBounds {
  if ('days' in window) {
    const today = startOfDay(now.getTime());
    return { start: today - window.days * DAY_MS, end: today + DAY_MS };
  }
  return { start: Date.parse(`${window.from}T00:00:00Z`), end: Date.parse(`${window.to}T00:00:00Z`) + DAY_MS };
}

/** The instant a time text names: a zoned time as it is, a local date time or a date as UTC. Anything else, a calendar date that does not exist included, is no usable time. */
export function instantOf(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const shape = INSTANT_SHAPE.exec(text);
  if (shape === null) return undefined;
  const [, date = '', zone] = shape;
  const unzoned = text.replace(/\[[^\]]*\]$/, '');
  const instant = Date.parse(zone === undefined && unzoned !== date ? `${unzoned}Z` : unzoned);
  if (Number.isNaN(instant) || !new Date(Date.parse(`${date}T00:00:00Z`)).toISOString().startsWith(date)) return undefined;
  return instant;
}

type Verdict = 'in' | 'out' | 'undated' | 'unjudged';

function interval(edge: GraphEdge): readonly [number, number] | undefined {
  const first = instantOf(edge.observedFirst ?? edge.observedAt);
  const last = instantOf(edge.observedLast ?? edge.observedAt);
  const known = first ?? last;
  if (known === undefined) return undefined;
  return [first ?? known, last ?? known];
}

function verdictOf(edge: GraphEdge, rows: readonly DatedRow[], bounds: TimeBounds): Verdict {
  if (edge.semantics === 'derived') return 'unjudged';
  if (!rows.some((row) => row.type === edge.type && row.from === edge.from.entityType && row.to === edge.to.entityType)) return 'unjudged';
  const span = interval(edge);
  if (span === undefined) return 'undated';
  return span[1] >= bounds.start && span[0] < bounds.end ? 'in' : 'out';
}

export interface TimeFiltered {
  /** The keys of the relationships whose time is outside the window. */
  readonly relationships: ReadonlySet<string>;
  /** The keys of the entities that have loaded relationships, every one of them outside the window. */
  readonly entities: ReadonlySet<string>;
  /** The loaded relationships of a dated row that have no usable time and stay shown. */
  readonly undated: number;
}

const NONE: TimeFiltered = { relationships: new Set(), entities: new Set(), undated: 0 };

const cache = new WeakMap<LoadedGraph, WeakMap<TimeFilter, { readonly day: number; readonly value: TimeFiltered }>>();

/** What the time window filters out of the loaded graph. The same graph, filter and UTC day give the same object. */
export function timeFilteredOf(graph: LoadedGraph, time: TimeFilter | undefined, now: Date = new Date()): TimeFiltered {
  if (time === undefined || time.rows.length === 0) return NONE;
  const day = startOfDay(now.getTime());
  let byFilter = cache.get(graph);
  if (byFilter === undefined) {
    byFilter = new WeakMap();
    cache.set(graph, byFilter);
  }
  const known = byFilter.get(time);
  if (known !== undefined && known.day === day) return known.value;
  const value = derive(graph, time, boundsOf(time.window, now));
  byFilter.set(time, { day, value });
  return value;
}

function derive(graph: LoadedGraph, time: TimeFilter, bounds: TimeBounds): TimeFiltered {
  const relationships = new Set<string>();
  const touching = new Map<string, { shown: number; total: number }>();
  let undated = 0;
  const count = (key: string, out: boolean): void => {
    const held = touching.get(key) ?? { shown: 0, total: 0 };
    held.total += 1;
    if (!out) held.shown += 1;
    touching.set(key, held);
  };
  for (const edge of graph.edges) {
    const verdict = verdictOf(edge, time.rows, bounds);
    const out = verdict === 'out';
    if (out) relationships.add(edgeKey(edge.ref));
    if (verdict === 'undated') undated += 1;
    count(elementKey(edge.from), out);
    count(elementKey(edge.to), out);
  }
  const entities = new Set(graph.nodes.map((node) => elementKey(node.ref)).filter((key) => {
    const held = touching.get(key);
    return held !== undefined && held.total > 0 && held.shown === 0;
  }));
  return { relationships, entities, undated };
}
