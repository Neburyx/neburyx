import type { IconKey, PiiClass, PresetTemplate } from '@neburyx/contracts';
import { buildLinkAddress } from './link-address.js';

/** The most properties a source may list under `search` in all its entity types: each is a branch of the one search read. */
export const MAX_SEARCH_PROPERTIES = 100;

/** The most properties a source may list under `reference` in all its entity types: each is a branch of the one related-records read. */
export const MAX_REFERENCE_PROPERTIES = 100;
export const MAX_EVIDENCE_PROPERTIES = 100;
/** The most probes one facet read holds: one for each entity type that has a target, one for each match mode and one for the total. */
export const MAX_FACET_PROBES = 50;

export type LinkKind = 'entity' | 'evidence';

export interface LinkTemplate {
  readonly kind: LinkKind;
  readonly template: string;
  readonly placeholder: string;
  /** Set when the link of a keyed entity type holds the value itself: the mapping says so, and the link is built only for an unmasked request. */
  readonly carriesValue?: true;
}

/** A node property the customer maintains with the degree of one (relationship type, direction) pair of the entity type; only a count above the cap of the live read may take it, as `estimated`. */
export interface DegreeDeclaration {
  readonly type: string;
  readonly direction: 'out' | 'in';
  readonly property: string;
  /** A second node property that holds when the customer computed the number; without it the estimate carries no date. */
  readonly observedAt?: string;
}

export interface EntityModel {
  readonly type: string;
  readonly label: string;
  readonly stableId: string;
  readonly title: string;
  readonly titleProperties: readonly string[];
  readonly titleUsesPii: boolean;
  readonly search: readonly string[];
  readonly reference: readonly string[];
  readonly pii: readonly string[];
  /** The class the mapping gives a `pii` field, which picks the shape of its mask; a field without one is masked fully. */
  readonly piiClasses?: Readonly<Record<string, PiiClass>>;
  readonly filterable: readonly string[];
  /** The properties an expansion may rank its pages by; present only when the mapping declares some, so a mapping without them keeps its configuration hash. */
  readonly sortable?: readonly string[];
  /** Present only when the mapping declares degree properties, so a mapping without them keeps its configuration hash. */
  readonly degree?: readonly DegreeDeclaration[];
  readonly link?: LinkTemplate;
  readonly display: {
    readonly name?: string;
    readonly icon: IconKey;
    readonly keyProperties: readonly string[];
    readonly stateProperty?: string;
  };
}

/** The link of an entity for a request: none when the type has none, none when the address cannot be built, and none for a keyed type while masked, since its link holds the value. Built from the raw value, which the caller read from the reference on the server. */
export function entityLinkFor(entity: Pick<EntityModel, 'link' | 'pii' | 'stableId'>, value: string, mask: boolean): string | undefined {
  const { link } = entity;
  if (link === undefined) return undefined;
  if (isKeyed(entity) && (mask || link.carriesValue !== true)) return undefined;
  return buildLinkAddress(link, value);
}

/** True when the stable ID property is also a `pii` property: the reference of such a node is a keyed token, never the value. Derived, so it is not part of the model and the configuration hash. */
export const isKeyed = (entity: Pick<EntityModel, 'pii' | 'stableId'>): boolean => entity.pii.includes(entity.stableId);

export interface RelationshipModel {
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly stableId?: string;
  readonly aggregate: boolean;
  readonly observedAt?: string;
  readonly evidence: readonly string[];
  readonly filterable: readonly string[];
  /** As for an entity type: present only when declared. */
  readonly sortable?: readonly string[];
  readonly evidenceLink?: LinkTemplate;
}

export interface DerivedRuleModel {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly via: readonly string[];
  readonly ruleVersion: number;
  readonly stopListProperty?: string;
}

export interface PresetModel {
  readonly id: string;
  readonly name: string;
  readonly template: PresetTemplate;
  readonly bind: Readonly<Record<string, string>>;
  readonly labels: Readonly<Record<string, string>>;
}

export interface BudgetsModel {
  readonly timeoutMs: number;
  readonly maxPage: number;
  readonly defaultPage: number;
  readonly maxHops: number;
  readonly pathResultsCap: number;
  readonly userConcurrency: number;
  readonly sourceConcurrency: number;
  readonly queueWaitMs: number;
  readonly breakerFailures: number;
  readonly breakerWindowMs: number;
  readonly breakerCooldownMs: number;
  readonly heavyOpThreshold: number;
  readonly requestsPerMinute: number;
}

export interface DemoCaseModel {
  readonly entityType: string;
  readonly stableId: string;
  readonly caseRef: string;
}

export interface SourceModel {
  readonly id: string;
  readonly uri: string;
  readonly database: string;
  readonly auth: { readonly usernameEnv: string; readonly passwordEnv: string };
  readonly synthetic: boolean;
  readonly demoCase?: DemoCaseModel;
  readonly budgets: BudgetsModel;
  readonly vocabulary: { readonly caseRef?: string };
  readonly entities: readonly EntityModel[];
  readonly relationships: readonly RelationshipModel[];
  readonly derived: readonly DerivedRuleModel[];
  readonly presets: readonly PresetModel[];
  readonly styleRules: readonly unknown[];
  readonly configHash: string;
}

export interface MappingModel {
  readonly sources: readonly SourceModel[];
}
