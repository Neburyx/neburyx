import type { Seams } from '../seams/seams.js';
import type { ReferenceKeys } from '../reference/keys.js';
import type { ReadExecutor } from './executor.js';
import type { CursorCodec } from './cursor/codec.js';
import type { NormalizeModel } from './normalize/model.js';
import type { Budgets, Clock, GateContext, GateLogger, GateObserver, Item, SourceAllowlist, TemplateCatalog } from './types.js';

export interface GateDeps {
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly catalog: TemplateCatalog;
  readonly executor: ReadExecutor;
  readonly budgetsFor: (sourceId: string) => Budgets;
  readonly allowlistFor: (sourceId: string) => SourceAllowlist;
  readonly modelFor: (sourceId: string) => NormalizeModel;
  readonly cursors: CursorCodec;
  /** The keys of the reference tokens of keyed entity types. */
  readonly references: ReferenceKeys;
  readonly policyVersion: (sourceId: string) => string;
  readonly redact: (items: readonly Item[], context: GateContext) => readonly Item[];
  readonly clock: Clock;
  readonly logger: GateLogger;
  readonly observer?: GateObserver | undefined;
}
