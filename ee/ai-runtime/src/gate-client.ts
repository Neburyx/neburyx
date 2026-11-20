import type { AskPatternListing, AskPatternOffer, AskRunner, AskRunScope, ElementRefs, ElementsScope, ExtensionRequest, SummaryReading, TypeDescriptions } from '@neburyx/contracts';

/**
 * The one way AI code reaches the core. Every source read of an AI feature is one of these, each answered by the gate of the core for the caller of the request; a member is absent when the edition does not provide it.
 */
export interface GateClient {
  /** Runs an intent or a template on one source as the caller. */
  readonly runner?: (scope: AskRunScope) => AskRunner;
  readonly readElements?: (scope: ElementsScope, refs: ElementRefs) => Promise<SummaryReading>;
  /** Resolves when the caller may read the source; rejects with the `NOT_FOUND` refusal otherwise. */
  readonly sourceReadable?: (sourceId: string) => Promise<void>;
  readonly investigationReadable?: (investigationId: string, sourceId: string) => Promise<void>;
  readonly patterns?: (sourceId: string) => Promise<AskPatternListing>;
  readonly findPattern?: (sourceId: string, id: string) => Promise<AskPatternOffer | undefined>;
  /** The descriptions the mapping gives the types of a source; absent, none reaches a model. */
  readonly typeDescriptions?: (sourceId: string) => TypeDescriptions;
}

type Capabilities = Pick<ExtensionRequest, 'askRunner' | 'readElements' | 'askSourceReadable' | 'investigationReadable' | 'askPatterns' | 'askPatternFind' | 'typeDescriptions'>;

/** The gate client of a request: its capabilities and no other member of the request. */
export function gateClientOf(request: Capabilities): GateClient {
  return {
    runner: request.askRunner,
    readElements: request.readElements,
    sourceReadable: request.askSourceReadable,
    investigationReadable: request.investigationReadable,
    patterns: request.askPatterns,
    findPattern: request.askPatternFind,
    typeDescriptions: request.typeDescriptions,
  };
}
