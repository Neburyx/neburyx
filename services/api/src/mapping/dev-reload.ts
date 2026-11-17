import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { SourceGateError } from '../gate/allowlist.js';
import type { GateParts, SwitchableGate } from '../gate/switchable-gate.js';
import type { ReachabilityCache } from '../source-ping/cache.js';
import type { LiveMapping } from './live.js';
import type { MappingModel, SourceModel } from './model.js';
import { reloadStep } from './reload.js';

const DEFAULT_DEBOUNCE_MS = 300;

type ReloadOutcome = { readonly kind: 'applied' | 'unchanged' } | { readonly kind: 'refused'; readonly message: string };

interface Log {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface DevReloadDeps {
  readonly path: string;
  readonly live: LiveMapping;
  readonly gate: SwitchableGate;
  /** Builds the gate of a mapping; it throws when the gate refuses the mapping. */
  readonly openGate: (mapping: MappingModel) => GateParts;
  readonly syncSources: (sources: readonly SourceModel[]) => Promise<readonly string[]>;
  readonly reachability: ReachabilityCache;
  /** Ends the source ping and the first-contact check, and waits for them. */
  readonly pause: () => Promise<void>;
  /** Starts them again, with the mapping the process holds then. */
  readonly resume: () => void;
  readonly extensionLoaded: boolean;
  readonly logger: Log;
  readonly watch?: typeof fsWatch;
  readonly debounceMs?: number;
}

export interface DevReloader {
  /** Reads the file and applies it if it is good, after any reload that is running; the answer says what happened. */
  reloadNow(): Promise<ReloadOutcome>;
  /** Ends the watching and prevents a reload that is running from starting the checks again; for the start of a shutdown. */
  stop(): void;
  /** `stop`, then waits for a reload that is running. */
  close(): Promise<void>;
}

/**
 * The dev reload: watches the folder of the mapping file (an editor that saves by rename replaces the file, so the file itself would not keep telling) and, a debounce after the last change to it,
 * runs one reload, one at a time. A reload reads and checks the file, builds the new gate, records the sources, and only then replaces the mapping, the gate, the reachability counts and the checks in one step;
 * anything that fails before that leaves what served until then serving, and says why in the log.
 */
export function createDevReloader(deps: DevReloadDeps): DevReloader {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  let running: Promise<unknown> = Promise.resolve();
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  let stopped = false;

  const refuse = (reason: string): ReloadOutcome => {
    deps.logger.warn({ event: 'mapping.reload_refused', reason }, `the mapping file was not loaded: ${reason}`);
    return { kind: 'refused', message: reason };
  };

  async function reload(): Promise<ReloadOutcome> {
    const step = reloadStep({ path: deps.path, held: deps.live.current(), extensionLoaded: deps.extensionLoaded });
    if (step.kind === 'refused') return refuse(step.message);
    if (step.kind === 'unchanged') {
      deps.logger.info({ event: 'mapping.reload_unchanged' }, 'the mapping file was saved and holds the mapping that is served');
      return { kind: 'unchanged' };
    }
    let opened: GateParts;
    try {
      opened = deps.openGate(step.mapping);
    } catch (error) {
      // as at start, only the message of a gate refusal is shown; any other error is not described, because its text could hold anything
      return refuse(error instanceof SourceGateError ? `the gate refused the mapping: ${error.message}` : 'the gate could not be built from the mapping');
    }
    try {
      await deps.syncSources(step.mapping.sources);
    } catch {
      await opened.close().catch(() => undefined);
      return refuse('the sources could not be recorded; the mapping that is served stays');
    }
    await deps.pause();
    deps.live.replace(step.mapping);
    deps.reachability.replaceSources(step.mapping.sources.map((source) => source.id));
    void deps.gate.swap(opened).catch(() => undefined);
    if (!stopped) deps.resume();
    deps.logger.info({ event: 'mapping.reloaded', added: step.added, changed: step.changed, removed: step.removed }, 'the mapping file was loaded again');
    return { kind: 'applied' };
  }

  const reloadNow = (): Promise<ReloadOutcome> => {
    const next = running.then(reload, reload);
    running = next.catch(() => undefined);
    return next;
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reloadNow().catch(() => deps.logger.warn({ event: 'mapping.reload_failed' }, 'the mapping file could not be loaded again'));
    }, debounceMs);
    timer.unref();
  };

  const file = basename(deps.path);
  watcher = (deps.watch ?? fsWatch)(dirname(deps.path), { persistent: false }, (_event, name) => {
    if (name === null || name === undefined || name.toString() === file) schedule();
  });
  watcher.on('error', () => deps.logger.warn({ event: 'mapping.watch_failed' }, 'the mapping file is no longer watched'));

  const stop = (): void => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    watcher?.close();
    watcher = undefined;
  };

  return {
    reloadNow,
    stop,
    async close() {
      stop();
      await running;
    },
  };
}
