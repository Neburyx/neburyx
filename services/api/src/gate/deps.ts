import type { Seams } from '../seams/seams.js';
import type { SourceUsability } from '../source-test/usability.js';
import type { ReadExecutor } from './executor.js';
import type { Budgets, Clock, GateContext, GateLogger, GateObserver, Item, SourceAllowlist, TemplateCatalog } from './types.js';

export interface GateDeps {
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly catalog: TemplateCatalog;
  readonly executor: ReadExecutor;
  readonly budgetsFor: (sourceId: string) => Budgets;
  readonly allowlistFor: (sourceId: string) => SourceAllowlist;
  readonly redact: (items: readonly Item[], context: GateContext) => readonly Item[];
  readonly clock: Clock;
  readonly logger: GateLogger;
  readonly observer?: GateObserver | undefined;
  /** Whether a data read may go to a source; required, so that a gate built without it cannot be mistaken for one that checks. */
  readonly usability: SourceUsability;
}
