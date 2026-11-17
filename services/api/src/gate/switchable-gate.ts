import type { FileQueryRequest, Gate, GatePage, GateRequest, IndexReader, SystemRunner, TemplateCatalog } from './types.js';

/** What a source gate holds that is served through the switchable one; a `SourceGate` has all of it. */
export interface GateParts {
  readonly gate: Gate;
  readonly system: SystemRunner;
  readonly indexes: IndexReader;
  readonly catalog: TemplateCatalog;
  close(): Promise<void>;
}

interface Held {
  readonly source: GateParts;
  inFlight: number;
  retired: boolean;
  closing: Promise<void> | undefined;
  /** Settles when the gate is closed. */
  readonly done: Promise<void>;
  finish(): void;
}

function heldOf(source: GateParts): Held {
  let finish = (): void => undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { source, inFlight: 0, retired: false, closing: undefined, done, finish };
}

export interface SwitchableGate {
  readonly gate: Gate;
  readonly system: SystemRunner;
  readonly indexes: IndexReader;
  readonly catalog: TemplateCatalog;
  /** Serves from the next gate from now on; the one it replaces is closed when no call is left in flight through it, and the answer settles when it is. */
  swap(next: GateParts): Promise<void>;
  /** Closes the gate it holds and every retired one that is still open. */
  close(): Promise<void>;
}

/**
 * The gate, the system runner, the index reader and the catalog of the source gate that is current, behind one object that does not change when the dev reload replaces the gate.
 * Each call goes to the gate that was current when it began and counts as in flight on it until it ends, so a read that began before a swap ends on the gate it began on.
 */
export function createSwitchableGate(initial: GateParts): SwitchableGate {
  let current: Held = heldOf(initial);
  const all: Held[] = [current];

  const close = (held: Held): Promise<void> => {
    held.closing ??= held.source.close().finally(() => held.finish());
    return held.closing;
  };
  const settle = (held: Held): void => {
    held.inFlight -= 1;
    if (held.retired && held.inFlight === 0) void close(held).catch(() => undefined);
  };
  async function through<T>(use: (source: GateParts) => Promise<T>): Promise<T> {
    const held = current;
    held.inFlight += 1;
    try {
      return await use(held.source);
    } finally {
      settle(held);
    }
  }

  return {
    gate: {
      run: (request: GateRequest): Promise<GatePage> => through((source) => source.gate.run(request)),
      fileQuery: (request: FileQueryRequest): Promise<GatePage> => through((source) => source.gate.fileQuery(request)),
      runMany: (requests: readonly GateRequest[]): Promise<readonly GatePage[]> => through((source) => source.gate.runMany(requests)),
    },
    system: { run: (request) => through((source) => source.system.run(request)) },
    indexes: { read: (request) => through((source) => source.indexes.read(request)) },
    catalog: {
      find: (templateId) => current.source.catalog.find(templateId),
      isEnabled: (templateId, sourceId) => current.source.catalog.isEnabled(templateId, sourceId),
    },
    swap(next) {
      const old = current;
      current = heldOf(next);
      all.push(current);
      old.retired = true;
      return old.inFlight === 0 ? close(old) : old.done;
    },
    async close() {
      for (const held of all) held.retired = true;
      await Promise.all(all.map((held) => close(held)));
    },
  };
}
