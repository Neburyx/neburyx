import type { MappingModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { assembleGate } from './assemble.js';
import type { CursorCodec } from './cursor/codec.js';
import type { Clock, Gate, GateLogger, GateObserver, IndexReader, SystemRunner } from './types.js';

export interface SourceGateOptions {
  readonly mapping: MappingModel;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly logger: GateLogger;
  readonly clock?: Clock;
  readonly observer?: GateObserver;
  /** Signs and checks page cursors; absent, the gate signs with a key of its own. */
  readonly cursors?: CursorCodec;
  /** The keys of the reference tokens of keyed entity types. */
  readonly referenceKeys?: ReferenceKeys;
}

export interface SourceGate {
  readonly gate: Gate;
  readonly system: SystemRunner;
  readonly indexes: IndexReader;
  close(): Promise<void>;
}

/** The one place that joins the gate to the Neo4j adapter: it builds the executor from the mapping and the environment itself. */
export function createSourceGate(options: SourceGateOptions): SourceGate {
  const executor = createNeo4jExecutor({
    sources: options.mapping.sources,
    env: options.env,
    logger: options.logger,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
  try {
    const { gate, system, indexes } = assembleGate({
      mapping: options.mapping,
      seams: options.seams,
      executor,
      logger: options.logger,
      ...(options.cursors === undefined ? {} : { cursors: options.cursors }),
      ...(options.referenceKeys === undefined ? {} : { referenceKeys: options.referenceKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    });
    return { gate, system, indexes, close: () => executor.close() };
  } catch (error) {
    void executor.close();
    throw error;
  }
}
