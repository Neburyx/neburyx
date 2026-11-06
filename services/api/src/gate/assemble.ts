import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import type { SourceUsability } from '../source-test/usability.js';
import { allowlistFromMapping } from './allowlist.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { createTemplateCatalog } from './catalog.js';
import type { ReadExecutor } from './executor.js';
import { createGates } from './gate.js';
import { redactItems } from './redact/index.js';
import { createCursorCodec, type CursorCodec } from './cursor/codec.js';
import { normalizeModelOf } from './normalize/model.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { connectivityTemplate } from './templates/connectivity.js';
import { degreeProbeTemplate } from './templates/degree-probe.js';
import { entityLoadTemplate } from './templates/entity-load.js';
import { privilegesTemplate } from './templates/privileges.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import { schemaTokensTemplate } from './templates/schema-tokens.js';
import { stableIdDuplicatesTemplate } from './templates/stable-id-duplicates.js';
import type { Budgets, Clock, Gate, GateLogger, GateObserver, Item, SourceAllowlist, SystemRunner, TemplateCatalog, GateContext } from './types.js';

export interface AssembleOptions {
  readonly mapping: MappingModel;
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly executor: ReadExecutor;
  readonly logger: GateLogger;
  readonly clock?: Clock;
  readonly observer?: GateObserver;
  readonly catalog?: TemplateCatalog;
  readonly redact?: (items: readonly Item[], context: GateContext) => readonly Item[];
  /** Whether a data read may go to a source. */
  readonly usability: SourceUsability;
  /** Signs and checks page cursors; absent, the gate signs with a key of its own that no other process has. */
  readonly cursors?: CursorCodec;
  /** The version of the policy a cursor is bound to; Community has none. */
  readonly policyVersion?: (sourceId: string) => string;
}

export function defaultCatalog(): TemplateCatalog {
  return createTemplateCatalog({ templates: [connectivityTemplate, capabilitiesTemplate, privilegesTemplate, schemaTokensTemplate, schemaIndexesTemplate, stableIdDuplicatesTemplate, degreeProbeTemplate, entityLoadTemplate] });
}

function budgetsFrom(source: SourceModel): Budgets {
  return { timeoutMs: source.budgets.timeoutMs, maxPage: source.budgets.maxPage, requestTimeoutMs: DEFAULT_BUDGETS.requestTimeoutMs };
}

export function assembleGate(options: AssembleOptions): { readonly gate: Gate; readonly system: SystemRunner } {
  const budgets = new Map(options.mapping.sources.map((source) => [source.id, budgetsFrom(source)]));
  const allowlists = new Map<string, SourceAllowlist>(options.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  const models = new Map(options.mapping.sources.map((source) => [source.id, normalizeModelOf(source)]));
  return createGates({
    seams: options.seams,
    catalog: options.catalog ?? defaultCatalog(),
    executor: options.executor,
    budgetsFor: (sourceId) => {
      const found = budgets.get(sourceId);
      if (found === undefined) throw new AppError('NOT_FOUND');
      return found;
    },
    cursors: options.cursors ?? createCursorCodec({ key: randomBytes(32), clock: options.clock ?? Date.now }),
    policyVersion: options.policyVersion ?? (() => 'none'),
    modelFor: (sourceId) => {
      const found = models.get(sourceId);
      if (found === undefined) throw new AppError('NOT_FOUND');
      return found;
    },
    allowlistFor: (sourceId) => {
      const found = allowlists.get(sourceId);
      if (found === undefined) throw new AppError('NOT_FOUND');
      return found;
    },
    redact: options.redact ?? redactItems,
    clock: options.clock ?? Date.now,
    logger: options.logger,
    observer: options.observer,
    usability: options.usability,
  });
}
