import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import type { Seams } from '../seams/seams.js';
import { allowlistFromMapping } from './allowlist.js';
import { DEFAULT_BUDGETS } from './budgets.js';
import { createTemplateCatalog, type TemplateDefinition } from './catalog.js';
import type { ReadExecutor } from './executor.js';
import { createGates } from './gate.js';
import { redactItems } from './redact/index.js';
import { createCursorCodec, type CursorCodec } from './cursor/codec.js';
import { deriveReferenceKeys, type ReferenceKeys } from '../reference/keys.js';
import { normalizeModelOf } from './normalize/model.js';
import { capabilitiesTemplate } from './templates/capabilities.js';
import { connectivityTemplate } from './templates/connectivity.js';
import { degreePreviewBoundedTemplate, degreePreviewCheapTemplate } from './templates/degree-preview.js';
import { degreeProbeTemplate } from './templates/degree-probe.js';
import { entityLoadTemplate } from './templates/entity-load.js';
import { expandNeighborsTemplate } from './templates/expand-neighbors.js';
import { searchExactTemplate } from './templates/search-exact.js';
import { searchPrefixTemplate } from './templates/search-prefix.js';
import { searchEvidenceTemplate } from './templates/search-evidence.js';
import { searchFacetsTemplate } from './templates/search-facets.js';
import { searchRelatedTemplate } from './templates/search-related.js';
import { relatedContextTemplate } from './templates/related-context.js';
import { privilegesTemplate } from './templates/privileges.js';
import { schemaIndexesTemplate } from './templates/schema-indexes.js';
import { schemaTokensTemplate } from './templates/schema-tokens.js';
import { stableIdDuplicatesTemplate } from './templates/stable-id-duplicates.js';
import type { Budgets, Clock, Gate, GateLogger, IndexReader, GateObserver, Item, SourceAllowlist, SystemRunner, TemplateCatalog, GateContext } from './types.js';

export interface AssembleOptions {
  readonly mapping: MappingModel;
  readonly seams: Pick<Seams, 'policy' | 'coordinator' | 'audit'>;
  readonly executor: ReadExecutor;
  readonly logger: GateLogger;
  readonly clock?: Clock;
  readonly observer?: GateObserver;
  readonly catalog?: TemplateCatalog;
  readonly redact?: (items: readonly Item[], context: GateContext) => readonly Item[];
  /** Signs and checks page cursors; absent, the gate signs with a key of its own that no other process has. */
  readonly cursors?: CursorCodec;
  /** The keys of the reference tokens of keyed entity types; absent, the gate makes keys of its own, which no other process has, so a token does not outlive the process. */
  readonly referenceKeys?: ReferenceKeys;
  /** The version of the policy a cursor is bound to; Community has none. */
  readonly policyVersion?: (sourceId: string) => string;
}

export function defaultCatalogTemplates(): readonly TemplateDefinition[] {
  return [connectivityTemplate, capabilitiesTemplate, privilegesTemplate, schemaTokensTemplate, schemaIndexesTemplate, stableIdDuplicatesTemplate, degreeProbeTemplate, degreePreviewBoundedTemplate, degreePreviewCheapTemplate, entityLoadTemplate, expandNeighborsTemplate, searchExactTemplate, searchRelatedTemplate, searchEvidenceTemplate, searchFacetsTemplate, searchPrefixTemplate, relatedContextTemplate];
}

export function defaultCatalog(): TemplateCatalog {
  return createTemplateCatalog({ templates: defaultCatalogTemplates() });
}

function budgetsFrom(source: SourceModel): Budgets {
  return {
    timeoutMs: source.budgets.timeoutMs,
    maxPage: source.budgets.maxPage,
    requestTimeoutMs: DEFAULT_BUDGETS.requestTimeoutMs,
    countCap: source.budgets.heavyOpThreshold,
    userConcurrency: source.budgets.userConcurrency,
    sourceConcurrency: source.budgets.sourceConcurrency,
    queueWaitMs: source.budgets.queueWaitMs,
    breaker: { failures: source.budgets.breakerFailures, windowMs: source.budgets.breakerWindowMs, cooldownMs: source.budgets.breakerCooldownMs },
  };
}

export function assembleGate(options: AssembleOptions): { readonly gate: Gate; readonly system: SystemRunner; readonly indexes: IndexReader } {
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
    references: options.referenceKeys ?? deriveReferenceKeys(randomBytes(32)),
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
  });
}
