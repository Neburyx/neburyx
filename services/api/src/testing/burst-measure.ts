import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { AuditEvent, AuditSink } from '@neburyx/contracts';
import { createAuditQueue } from '../audit/queue.js';
import type { AuditSettings } from '../audit/settings.js';

/** The share of a limit above which a measured figure is called close to it. */
const CLOSE = 0.8;
const WINDOW_MS = 60_000;

export type Verdict = 'inside' | 'close' | 'over';

/** Inside up to 80% of a limit, close above that, over past the limit. */
export function verdictOf(observed: number, limit: number): Verdict {
  return observed > limit ? 'over' : observed > limit * CLOSE ? 'close' : 'inside';
}

/** The value at a rank of the values, by the nearest-rank rule. */
export function percentile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))] ?? 0;
}

export interface BurstPlan {
  /** People sending turns at the rate limit on one source. */
  readonly people: number;
  /** Requests one person may send in the window (the request rate limit). */
  readonly requestsPerPerson: number;
  /** The audit events one turn emits. */
  readonly eventsPerTurn: number;
}

export interface BurstResult {
  readonly emitted: number;
  readonly written: number;
  readonly failed: number;
  readonly dropped: number;
  readonly queued: number;
  readonly peakQueued: number;
  readonly attempts: number;
}

interface Timer {
  readonly at: number;
  readonly id: number;
  readonly run: () => void;
}

/** A clock a run moves itself, so a minute of a stalled sink takes no real time. */
function fakeClock() {
  let now = 0;
  let next = 0;
  let timers: Timer[] = [];
  const settle = (): Promise<void> => new Promise((done) => setImmediate(done));
  return {
    timers: {
      setTimeout(run: () => void, ms: number): unknown {
        next += 1;
        timers.push({ at: now + ms, id: next, run });
        return next;
      },
      clearTimeout(handle: unknown): void {
        timers = timers.filter((timer) => timer.id !== handle);
      },
    },
    async advanceTo(target: number): Promise<void> {
      await settle();
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        due.run();
        await settle();
      }
      now = Math.max(now, target);
    },
  };
}

/** A sink that never answers until its write is aborted, as a sink that stalls for the whole write time limit. */
function stalledSink(counter: { attempts: number }): AuditSink {
  return {
    record: (_event, options) =>
      new Promise<void>((_resolve, reject) => {
        counter.attempts += 1;
        options?.signal?.addEventListener('abort', () => reject(new Error('stalled')));
      }),
  };
}

/** The real queue over a stalled sink, fed the events of a burst spread evenly over a window; nothing is lost without being counted when `written + failed + dropped + queued` is the events emitted less those still being written. */
export async function runBurst(settings: AuditSettings, plan: BurstPlan): Promise<BurstResult> {
  const clock = fakeClock();
  const counter = { attempts: 0 };
  const queue = createAuditQueue({ sinks: [{ name: 'stalled', sink: stalledSink(counter) }], settings, logger: { warn: () => undefined }, timers: clock.timers });
  const emitted = plan.people * plan.requestsPerPerson * plan.eventsPerTurn;
  let peakQueued = 0;
  for (let index = 0; index < emitted; index += 1) {
    await clock.advanceTo(Math.floor((index * WINDOW_MS) / emitted));
    const event: AuditEvent = { actorId: `person-${String(index % plan.people)}`, actorRole: 'investigator', action: 'assistant.step', result: 'success', traceId: `trace-${String(index)}` };
    await queue.sink.record(event);
    peakQueued = Math.max(peakQueued, queue.counts().queued);
  }
  await clock.advanceTo(WINDOW_MS);
  const counts = queue.counts();
  return { emitted, written: counts.written, failed: counts.failed, dropped: counts.dropped, queued: counts.queued, peakQueued, attempts: counter.attempts };
}

/** The smallest queue size that drops none of the burst: the deepest the queue got when it could not drop. */
export async function smallestSizeWithoutDrops(settings: AuditSettings, plan: BurstPlan, highest: number): Promise<number | undefined> {
  const open = await runBurst({ ...settings, queueSize: highest }, plan);
  if (open.dropped > 0) return undefined;
  const size = Math.max(1, open.peakQueued);
  const check = await runBurst({ ...settings, queueSize: size }, plan);
  return check.dropped === 0 ? size : undefined;
}

const gitTree = (folder: string): boolean => {
  for (let at = folder; ; at = dirname(at)) {
    if (existsSync(join(at, '.git'))) return true;
    if (dirname(at) === at) return false;
  }
};

/** Writes a record of a measurement to a folder outside every git working tree, reachable by its owner only; a link, a folder that others can reach or a folder inside a working tree is refused, and a file that already exists is made owner-only. */
export function writeMeasureRecord(folder: string, name: string, data: unknown): string {
  const target = resolve(folder);
  let nearest = target;
  while (!existsSync(nearest) && dirname(nearest) !== nearest) nearest = dirname(nearest);
  if (gitTree(realpathSync(nearest))) throw new Error('the record folder is inside a git working tree');
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error('the record folder is a link');
    if ((statSync(target).mode & 0o077) !== 0) throw new Error('the record folder can be reached by others');
  } else {
    mkdirSync(target, { recursive: true, mode: 0o700 });
  }
  const file = join(target, name);
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error('the record file is a link');
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** A proposal for a limit a measurement found close or over: the observed figure with a 25% margin, within the highest value the setting accepts. */
export function proposed(observed: number, highest: number): number {
  return Math.min(highest, Math.ceil(observed * 1.25));
}
