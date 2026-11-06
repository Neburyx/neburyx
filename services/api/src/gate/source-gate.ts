import type { MappingModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import type { SourceUsability } from '../source-test/usability.js';
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
  /** Whether a data read may go to a source: the record of the running server, or one in which every source is unchecked for a process that runs system-scope templates only. */
  readonly usability: SourceUsability;
  /** Signs and checks page cursors; absent, the gate signs with a key of its own. */
  readonly cursors?: CursorCodec;
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
      usability: options.usability,
      ...(options.cursors === undefined ? {} : { cursors: options.cursors }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    });
    return { gate, system, indexes, close: () => executor.close() };
  } catch (error) {
    void executor.close();
    throw error;
  }
}
