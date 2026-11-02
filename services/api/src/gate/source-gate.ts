import type { MappingModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { assembleGate } from './assemble.js';
import type { Clock, Gate, GateLogger, GateObserver, SystemRunner } from './types.js';

export interface SourceGateOptions {
  readonly mapping: MappingModel;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly logger: GateLogger;
  readonly clock?: Clock;
  readonly observer?: GateObserver;
}

export interface SourceGate {
  readonly gate: Gate;
  readonly system: SystemRunner;
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
    const { gate, system } = assembleGate({
      mapping: options.mapping,
      seams: options.seams,
      executor,
      logger: options.logger,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
    });
    return { gate, system, close: () => executor.close() };
  } catch (error) {
    void executor.close();
    throw error;
  }
}
