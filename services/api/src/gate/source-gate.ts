import type { MappingModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import type { ReferenceKeys } from '../reference/keys.js';
import { createNeo4jExecutor } from '../sources/executor.js';
import { assembleGate } from './assemble.js';
import type { CursorCodec } from './cursor/codec.js';
import type { FileQueryDeps } from './file-query.js';
import type { Clock, Gate, GateLogger, GateObserver, IndexReader, SystemRunner, TemplateCatalog } from './types.js';

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
  /** Where file queries get their text, from the Ask folder of the enterprise extension; absent, every file query is refused. */
  readonly fileQueries?: FileQueryDeps;
}

export interface SourceGate {
  readonly gate: Gate;
  readonly system: SystemRunner;
  readonly indexes: IndexReader;
  /** The catalog the gate validates against, which the routes that describe it read. */
  readonly catalog: TemplateCatalog;
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
    const { gate, system, indexes, catalog } = assembleGate({
      mapping: options.mapping,
      seams: options.seams,
      executor,
      logger: options.logger,
      ...(options.cursors === undefined ? {} : { cursors: options.cursors }),
      ...(options.referenceKeys === undefined ? {} : { referenceKeys: options.referenceKeys }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(options.observer === undefined ? {} : { observer: options.observer }),
      ...(options.fileQueries === undefined ? {} : { fileQueries: options.fileQueries }),
    });
    return { gate, system, indexes, catalog, close: () => executor.close() };
  } catch (error) {
    void executor.close();
    throw error;
  }
}
