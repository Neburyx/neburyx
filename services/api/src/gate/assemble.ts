import { AppError } from '../errors.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import type { SourceUsability } from '../source-test/usability.js';
import { allowlistFromMapping } from './allowlist.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { createTemplateCatalog } from './catalog.js';
import type { ReadExecutor } from './executor.js';
import { createGates } from './gate.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { connectivityTemplate } from './templates/connectivity.js';
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
}

export function defaultCatalog(): TemplateCatalog {
  return createTemplateCatalog({ templates: [connectivityTemplate, capabilitiesTemplate, privilegesTemplate, schemaTokensTemplate, schemaIndexesTemplate, stableIdDuplicatesTemplate] });
}

function budgetsFrom(source: SourceModel): Budgets {
  return { timeoutMs: source.budgets.timeoutMs, maxPage: source.budgets.maxPage, requestTimeoutMs: DEFAULT_BUDGETS.requestTimeoutMs };
}

export function assembleGate(options: AssembleOptions): { readonly gate: Gate; readonly system: SystemRunner } {
  const budgets = new Map(options.mapping.sources.map((source) => [source.id, budgetsFrom(source)]));
  const allowlists = new Map<string, SourceAllowlist>(options.mapping.sources.map((source) => [source.id, allowlistFromMapping(source)]));
  return createGates({
    seams: options.seams,
    catalog: options.catalog ?? defaultCatalog(),
    executor: options.executor,
    budgetsFor: (sourceId) => {
      const found = budgets.get(sourceId);
      if (found === undefined) throw new AppError('NOT_FOUND');
      return found;
    },
    allowlistFor: (sourceId) => {
      const found = allowlists.get(sourceId);
      if (found === undefined) throw new AppError('NOT_FOUND');
      return found;
    },
    redact: options.redact ?? ((items) => items),
    clock: options.clock ?? Date.now,
    logger: options.logger,
    observer: options.observer,
    usability: options.usability,
  });
}
