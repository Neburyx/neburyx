import type { ElementRef } from '@neburyx/contracts';
import type { ZodType } from 'zod';
import type { CursorPosition } from './cursor/codec.js';
import type { IndexEntry } from './templates/schema-indexes.js';
import type { NormalizeContext, NormalizeModel } from './normalize/model.js';
import type { AppError } from '../errors.js';
import type { Principal } from '../seams/seams.js';

export const GATE_STAGES = ['resolve', 'validate', 'authorize', 'execute', 'normalize', 'redact', 'audit'] as const;
export type GateStage = (typeof GATE_STAGES)[number];

export type { ElementRef };

export type Params = Readonly<Record<string, unknown>>;
export type Row = Readonly<Record<string, unknown>>;
export type Item = Readonly<Record<string, unknown>>;

export type TemplateScope = 'system' | 'user';

/** The failure of the caller's read of the schema (a timeout, a busy or unavailable source, an answer that cannot be read or is truncated), handed to the run so that the run fails with it and is audited. */
export interface IndexReadFailure {
  readonly failure: AppError;
}

/** The indexes of one source as one read of its schema found them. */
export interface IndexSnapshot {
  readonly sourceId: string;
  readonly entries: readonly IndexEntry[];
}

/** An index a read needs: of an entity type's property, a RANGE index or constraint (`value`), or one of any kind (`any`, a TEXT index is enough). */
export interface IndexNeed {
  readonly entityType: string;
  readonly property: string;
  readonly accepts: 'value' | 'any';
}

/** An index a read needs on a relationship property: of a relationship type between two entity types, of one kind as for an entity (`value` or `any`). */
export interface RelationshipIndexNeed {
  readonly relationshipType: string;
  readonly from: string;
  readonly to: string;
  readonly property: string;
  readonly accepts: 'value' | 'any';
}

/** A property a request uses: of an entity type, or of the relationship mapping row of a relationship type between two entity types. */
export type UsedProperty = { readonly entityType: string; readonly property: string } | { readonly relationshipType: string; readonly from: string; readonly to: string; readonly property: string };

/** One operator of the plan that a profiled read returns: its name, the server's description of it and the db hits it made. */
export interface PlanOperator {
  readonly name: string;
  readonly details: string | null;
  readonly dbHits: number;
}

/** The plan of a profiled read: null when the read did not complete, the server sent no profile, or the plan is too large to keep. */
export type Plan = readonly PlanOperator[] | null;

/** The parameters the gate fills in from the source's allowlist; a request cannot give them. */
export const GATE_PARAMETERS = ['mappedLabels', 'mappedTypes', 'mappedProperties'] as const;
export type GateParameter = (typeof GATE_PARAMETERS)[number];

export interface Template {
  readonly id: string;
  readonly version: string;
  readonly auditAction: string;
  readonly cypher: string;
  readonly paramsSchema: ZodType<Params>;
  readonly scope: TemplateScope;
  readonly paged: boolean;
  readonly entityParams: readonly string[];
  readonly relationshipParams: readonly string[];
  readonly integerParameters: readonly string[];
  /** The parameters of this template that the gate fills in (the Cypher uses each, and the parameter schema has none of them). */
  readonly gateParameters?: readonly GateParameter[];
  /** False for a template whose runs through the system runner write no audit event (the scheduled ping); absent means they do. */
  readonly auditSystemRuns?: boolean;
  /** True for a template whose Cypher starts with `PROFILE `: the executor returns the plan of the read and `normalize` gets it. */
  readonly profile?: boolean;
  /** What a cursor of this template binds besides the source, the person, the template and its parameters: the order of its pages; empty when it has none. */
  readonly sort?: string;
  /** The properties that a request searches, filters or sorts by, of entity types or of relationship mapping rows; a request that asks for masking may not use a `pii` one of an entity type. A template without it uses none. */
  usedProperties?(params: Params): readonly UsedProperty[];
  /**
   * The search template's own declaration, for no other template: a statement with one branch for each target of a list parameter. The Cypher holds `@searchBranches(<param>)`,
   * and the gate writes in, for each target, the branch text of its match form (`value` or `text`) with the placeholders replaced by the quoted names, joined by `UNION`: `@label` and `@property` for a
   * target of an entity type, `@type`, `@fromLabel`, `@toLabel` and `@property` for a target of a relationship mapping row. Each target is checked against the source's allowlist of the kind the
   * template names: its `search` or its `reference` properties, or the evidence properties of its relationship rows that have a `stable_id`.
   */
  readonly searchBranches?: { readonly param: string; readonly allowlist: 'search' | 'reference' | 'evidence'; readonly value: string; readonly text: string };
  /**
   * The facet template's own declaration, for no other template: a statement of probes, each a capped count of the distinct nodes (or relationships) that its targets match. The Cypher is the one marker
   * `@facetProbes(<param>)`; the list parameter holds the probes, each a non-empty list of targets of one kind (entity targets of the `search` or `reference` lists, or evidence properties of a relationship row
   * that has a `stable_id`), and the gate writes in, for each probe `i`, `CALL { CALL { <the probe's branches joined by UNION> } WITH n LIMIT $limit + 1 RETURN count(*) AS c<i> }` (the variable is `r` for
   * evidence), then one `RETURN c0, c1, …`: one row of integers. The branch texts are the template's, for the `value` and the `text` form of an entity target and of an evidence target, with the placeholders
   * of the search branches; each carries its own `LIMIT $limit + 1`.
   */
  readonly facetProbes?: { readonly param: string; readonly node: { readonly value: string; readonly text: string }; readonly evidence: { readonly value: string; readonly text: string } };
  /** The indexes this read needs, so that the gate can find out before the data read that they are there; a template that names none is not guarded. */
  indexNeeds?(params: Params, allowlist: SourceAllowlist): readonly (IndexNeed | RelationshipIndexNeed)[];
  /** True for a request that has nothing to read, such as an empty list of targets: the gate runs every stage but the read, and the answer has no row. */
  readsNothing?(params: Params): boolean;
  /** Where the page after this one starts, from the rows of this page; the gate signs it into the page's `nextCursor`. Only a paged template has one. */
  nextPosition?(rows: readonly Row[], limit: number): CursorPosition | undefined;
  refsOf(params: Params): readonly ElementRef[];
  normalize(rows: readonly Row[], plan?: Plan, context?: NormalizeContext): readonly Item[];
}

export interface SourceAllowlist {
  readonly entityLabels: ReadonlyMap<string, string>;
  readonly relationshipTypes: ReadonlySet<string>;
  /** The `stable_id` property of each entity type, by type. */
  readonly stableIds: ReadonlyMap<string, string>;
  /** The `search` properties of each entity type, by type, in the mapping's order. */
  readonly searchProperties: ReadonlyMap<string, readonly string[]>;
  /** The `reference` properties of each entity type, by type, in the mapping's order. */
  readonly referenceProperties: ReadonlyMap<string, readonly string[]>;
  /** The evidence properties of each relationship mapping row that has a `stable_id`, in the mapping's order: the rows an evidence read may name. */
  readonly evidenceRows: readonly { readonly type: string; readonly from: string; readonly to: string; readonly properties: readonly string[] }[];
  /** Every property name the mapping names: search, reference, evidence, sort and stable id properties. */
  readonly properties: ReadonlySet<string>;
}

export interface TemplateCatalog {
  find(templateId: string): Template | undefined;
  isEnabled(templateId: string, sourceId: string): boolean;
}

export interface Budgets {
  readonly timeoutMs: number;
  readonly maxPage: number;
  readonly requestTimeoutMs: number;
}

export interface GateRequest {
  readonly traceId: string;
  readonly principal: Principal;
  readonly sourceId: string;
  readonly templateId: string;
  readonly params: unknown;
  readonly limit: number;
  /** The `nextCursor` of an earlier page of the same read; only a paged template takes one. */
  readonly cursor?: string;
  /** Asks for the `pii` fields of the result to be masked; absent means no. */
  readonly mask?: boolean;
  /** The indexes of the source as the caller read them for this request, so that a request that makes several runs reads the schema once; a snapshot of another source is not used; `'unverified'` says the caller tried and the read could not say, so the gate does not read again; an `IndexReadFailure` says the read failed, and the run fails with that same error inside its own audited stages, with no data statement. */
  readonly indexes?: IndexSnapshot | 'unverified' | IndexReadFailure;
}

export interface GateContext {
  readonly traceId: string;
  readonly principal: Principal;
  readonly system: boolean;
  readonly sourceId: string;
  readonly budgets: Budgets;
  readonly allowlist: SourceAllowlist;
  /** The version of the policy this request is judged under; a cursor is bound to it. */
  readonly policyVersion: string;
  /** True when the request asks for the `pii` fields to be masked; the system runner never asks. */
  readonly mask: boolean;
  /** What the normalize stage needs of the source's mapping. */
  readonly model: NormalizeModel;
  readonly deadlineAt: number;
}

export interface GatePage {
  readonly items: readonly Item[];
  readonly hasMore: boolean;
  /** Signed for this request; present only when the read found more than the page and the template says where the next one starts. */
  readonly nextCursor?: string;
}

export interface GateObserver {
  stage(stage: GateStage, outcome: 'ok' | 'failed'): void;
}

export interface GateLogger {
  warn(fields: object, message: string): void;
}

export type Clock = () => number;

export interface Gate {
  run(request: GateRequest): Promise<GatePage>;
}

/**
 * Reads the indexes of a source as they are now, with the one fixed schema read of the gate's system runner; it runs nothing else, and only for a principal the policy allows on a source
 * that is usable. `'unverified'` when no read is made (the principal is refused or the source is not usable, and the run that follows is refused by its own rules) or the login may not list indexes. Any other failure of the read is thrown.
 */
export interface IndexReader {
  read(request: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string }): Promise<IndexSnapshot | 'unverified'>;
}

export interface SystemRequest {
  readonly traceId: string;
  readonly sourceId: string;
  readonly templateId: string;
  readonly params: unknown;
  readonly limit: number;
}

export interface SystemRunner {
  run(request: SystemRequest): Promise<GatePage>;
}
