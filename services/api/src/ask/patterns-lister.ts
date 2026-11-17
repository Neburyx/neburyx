import { patternDefinitionSchema, windowSchema, type AskPatternListing, type AskPatternOffer, type AskPatternProjection, type ExtensionRequest } from '@neburyx/contracts';
import type { PatternListPosition, PatternRow, PatternStore } from '../db/patterns-repository.js';
import { AppError } from '../errors.js';
import type { SourceAccess } from '../investigations/source-access.js';
import type { MappingModel, SourceModel } from '../mapping/model.js';
import { availabilityOf } from '../patterns/availability.js';
import { PATTERN_LIST_AUDIT_ACTION } from '../patterns/saved-pattern-service.js';
import type { Principal } from '../seams/seams.js';

/** The most saved patterns one question's catalog lists (a hypothesis, decided 2026-11-13); more exist than that when the listing says it is cut. */
export const ASK_PATTERN_CATALOG_MAX = 30;
/** The most pages of the caller's patterns the lister reads to fill the catalog with available ones (a hypothesis, decided 2026-11-13). */
export const ASK_PATTERN_READ_PAGES = 4;
const PAGE_SIZE = 25;

function presetProjectionOf(row: PatternRow, source: SourceModel): AskPatternProjection | undefined {
  const preset = source.presets.find((candidate) => candidate.id === row.presetId);
  const { anchor, via } = preset?.bind ?? {};
  const otherType = preset?.template === 'linked-entities' ? preset.bind['target'] : preset?.bind['attribute'];
  if (preset === undefined || anchor === undefined || via === undefined || otherType === undefined) return undefined;
  const params = row.params ?? {};
  const direction = params['direction'];
  const maxHops = params['maxHops'];
  const minShared = params['minShared'];
  return {
    kind: 'preset-run',
    template: preset.template,
    anchorType: anchor,
    startingEntity: row.askForStartingEntity ? 'asked' : 'held',
    otherType,
    relationshipTypes: [via],
    ...(direction === 'out' || direction === 'in' || direction === 'both' ? { direction } : {}),
    ...(typeof maxHops === 'number' ? { maxHops } : {}),
    ...(typeof minShared === 'number' ? { minShared } : {}),
    windowed: windowSchema.safeParse(params['window']).success,
  };
}

function projectionOf(row: PatternRow, source: SourceModel): AskPatternProjection | undefined {
  if (row.kind === 'preset-run') return presetProjectionOf(row, source);
  const parsed = patternDefinitionSchema.safeParse(row.definition);
  if (!parsed.success) return undefined;
  return {
    kind: 'definition',
    anchorType: parsed.data.anchorType,
    startingEntity: row.askForStartingEntity ? 'asked' : 'held',
    steps: parsed.data.steps.map((step) => ({
      relationshipTypes: step.relationshipTypes,
      direction: step.direction,
      arrivesAt: step.arrivesAt,
      conditions: (step.conditions ?? []).map((condition) => ({ on: condition.on, kind: condition.op })),
      windowed: step.window !== undefined,
      ...(step.after === undefined ? {} : { orderedAfterPrevious: true as const }),
      ...(step.fan === undefined ? {} : { fanAtLeast: step.fan.atLeast }),
      ...(step.closesAtAnchor === undefined ? {} : { closesAtAnchor: true as const }),
    })),
  };
}

function offerOf(row: PatternRow, source: SourceModel): AskPatternOffer | undefined {
  if (availabilityOf(row, source).status !== 'available') return undefined;
  const projection = projectionOf(row, source);
  return projection === undefined ? undefined : { id: row.id, version: row.version, name: row.name, projection };
}

export interface AskPatternListerDeps {
  readonly store: Pick<PatternStore, 'listOwnPatterns' | 'readPattern'>;
  readonly mapping: MappingModel;
  readonly access: SourceAccess;
}

/** The saved patterns the caller may run on a source, available against the current mapping, newest changed first: their own, never the shared ones of other people, up to the catalog's size. */
export function createAskPatternLister(deps: AskPatternListerDeps): (context: { readonly principal: Principal; readonly traceId: string }) => NonNullable<ExtensionRequest['askPatterns']> {
  return ({ principal, traceId }) =>
    async (sourceId) => {
      await deps.access.require({ traceId, principal, sourceId, auditAction: PATTERN_LIST_AUDIT_ACTION });
      const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const offers: AskPatternOffer[] = [];
      let after: PatternListPosition | undefined;
      for (let page = 0; page < ASK_PATTERN_READ_PAGES; page += 1) {
        const found = await deps.store.listOwnPatterns({ ownerId: principal.id, sourceId, limit: PAGE_SIZE, after });
        for (const row of found.rows) {
          const offer = offerOf(row, source);
          if (offer === undefined) continue;
          if (offers.length === ASK_PATTERN_CATALOG_MAX) return { offers, cut: true } satisfies AskPatternListing;
          offers.push(offer);
        }
        if (found.next === undefined) return { offers, cut: false };
        after = found.next;
      }
      return { offers, cut: true };
    };
}

/** One of the caller's own patterns by its id, as the listing would offer it, for a Continue of a saved pattern: it is not cut by the size of the catalog, and it is not offered when it is no longer one the caller may run on that source. */
export function createAskPatternFinder(deps: AskPatternListerDeps): (context: { readonly principal: Principal; readonly traceId: string }) => NonNullable<ExtensionRequest['askPatternFind']> {
  return ({ principal, traceId }) =>
    async (sourceId, id) => {
      await deps.access.require({ traceId, principal, sourceId, auditAction: PATTERN_LIST_AUDIT_ACTION });
      const source = deps.mapping.sources.find((candidate) => candidate.id === sourceId);
      if (source === undefined) throw new AppError('NOT_FOUND');
      const row = await deps.store.readPattern(id, principal.id);
      return row === undefined || row.sourceId !== sourceId ? undefined : offerOf(row, source);
    };
}
