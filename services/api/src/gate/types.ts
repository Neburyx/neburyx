import type { ElementRef } from '@neburyx/contracts';
import type { ZodType } from 'zod';
import type { CursorPosition } from './cursor/codec.js';
import type { IndexEntry } from './templates/schema-indexes.js';
import type { NormalizeContext, NormalizeModel } from './normalize/model.js';
import type { AppError } from '../errors.js';
import type { DegreeDeclaration } from '../mapping/model.js';
import type { BreakerLimits, Principal, ReadRole } from '../seams/seams.js';

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
/** `fixed-order` marks a property that only orders a page, a use the server decides and the request does not choose, so a masked request is not refused for it. */
export type UsedProperty = { readonly entityType: string; readonly property: string; readonly use?: 'fixed-order' } | { readonly relationshipType: string; readonly from: string; readonly to: string; readonly property: string };

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
  /**
   * What a template that is not paged returns, which it must declare: `one` for a read of a single aggregate row, `bounded` for a read whose rows its input bounds (the relationship context read: at most one row for each hit it is given, and the limit is not below that number), so a row beyond the limit is a defect that is refused, `cutMeans: 'duplicate'` for a read whose row beyond the limit only says that another record has the
   * same stable ID (the entity read, and the degree read anchored as it is), `cutMeans: 'lowerBound'` for a capped read whose cut means only that there are more matches than it returns (the type-ahead
   * prefix read): it is answered with `hasMore` and no cursor, and its count is a lower bound of the rows held. A read of a template that declares none of them and returns more rows than its limit is
   * refused, so a larger result is never cut silently.
   */
  readonly rows?: 'one' | 'bounded';
  /** For a read of a list: the list parameter whose length may not pass the limit of the request, so the rows of the read (one for each element at most) are never cut. */
  readonly boundedBy?: string;
  /** A template whose request names a number of hops: the integer parameter that holds it and the most hops the template reads. The gate refuses more than the lower of that and the source's `max_hops`. */
  readonly hops?: { readonly param: string; readonly max: number };
  readonly cutMeans?: 'duplicate' | 'lowerBound';
  /** What the template answers, in the words the Ask planner is given to choose between templates. */
  readonly description?: string;
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
  usedProperties?(params: Params, allowlist?: SourceAllowlist): readonly UsedProperty[];
  /**
   * The search template's own declaration, for no other template: a statement with one branch for each target of a list parameter. The Cypher holds `@searchBranches(<param>)`,
   * and the gate writes in, for each target, the branch text of its match form (`value` or `text`) with the placeholders replaced by the quoted names, joined by `UNION`: `@label` and `@property` for a
   * target of an entity type, `@type`, `@fromLabel`, `@toLabel` and `@property` for a target of a relationship mapping row. Each target is checked against the source's allowlist of the kind the
   * template names: its `search` or its `reference` properties, or the evidence properties of its relationship rows that have a `stable_id`. A search template is paged by keyset on the element ID of the
   * row's node (`n`) or relationship (`r`): each branch and the enclosing statement read the rows after `$cursor.after` in `ORDER BY elementId(…)`, cut at `LIMIT $limit + 1`.
   */
  readonly searchBranches?: { readonly param: string; readonly allowlist: 'search' | 'reference' | 'evidence'; readonly value: string; readonly text: string };
  /**
   * The facet template's own declaration, for no other template: a statement of probes, each a capped count of the distinct nodes (or relationships) that its targets match. The Cypher is the one marker
   * `@facetProbes(<param>)`; the list parameter holds the probes, each a non-empty list of targets of one kind (entity targets of the `search` or `reference` lists, or evidence properties of a relationship row
   * that has a `stable_id`), and the gate writes in, for each probe `i`, `CALL { CALL { <the probe's branches joined by UNION> } WITH n LIMIT $countCap + 1 RETURN count(*) AS c<i> }` (the variable is `r` for
   * evidence), then one `RETURN c0, c1, …`: one row of integers. The branch texts are the template's, for the `value` and the `text` form of an entity target and of an evidence target, with the placeholders
   * of the search branches; each carries its own `LIMIT $countCap + 1`. The gate fills `$countCap` from the budgets, never from the request.
   */
  readonly facetProbes?: { readonly param: string; readonly node: { readonly value: string; readonly text: string }; readonly evidence: { readonly value: string; readonly text: string } };
  /**
   * The degree template's own declaration, for no other template: a statement that counts the relationships of one node, one count for each mapped (relationship type, direction) pair of its entity type.
   * The Cypher is the one marker `@degreeCounts(<param>)`, the parameter names the entity type, and the gate writes the whole statement: the anchor lookup of the entity read, then for `bounded` one
   * `CALL` subquery for each pair that reads at most `$countCap + 1` relationships and counts them, or for `cheap` a `COUNT { }` expression for each pair, then one `RETURN` of every count as a column named by its position.
   */
  readonly degreeCounts?: { readonly param: string; readonly form: 'bounded' | 'cheap' };
  /**
   * The expansion template's own declaration, for no other template: a statement that reads one page of the relationships between one node and its neighbors of one entity type. The Cypher is the one marker
   * `@expandNeighbors(<param>)`; the parameters name the anchor's entity type, the neighbor entity type, the optional list of relationship types and the direction, and the gate writes the whole statement
   * from the mapping rows that join the two types: one branch for each row and direction that returns stored relationships (and, for a row mapped with a `stable_id`, an aggregate branch for those whose ID cannot be
   * used), and one for each row without a `stable_id` that returns one aggregate for each neighbor. Every name is quoted from the allowlist; the request holds no name, only values.
   */
  readonly expandNeighbors?: { readonly anchorParam: string; readonly neighborParam: string; readonly relTypesParam: string; readonly directionParam: string; /** `count`: one row, the number of relationships the same branches match, for the same filters; the default is a page. */ readonly form?: 'page' | 'count' };
  /**
   * The relationship context template's own declaration, for no other template: a statement that looks for one stored relationship between each of a list of hits and each of a list of exact matches (both lists of references of
   * entities of the source). The Cypher is the one marker `@relatedContext(<hits parameter>)`, and the gate writes the whole statement from the mapping rows that join the entity types present in the two lists: one branch for each
   * row and direction, each binding both ends by their stable ID before the relationship pattern. Every name is quoted from the allowlist and the request holds values only.
   */
  readonly relatedContext?: { readonly hitsParam: string; readonly exactParam: string };
  /**
   * The rule run template's own declaration, for no other template: a statement that finds the other ends of one derived rule of the mapping from one node and, for each, the first chain of nodes and relationships that
   * supports it. The Cypher is the one marker `@derivedRule(<rule parameter>)`; the rule is named by ID in the request and checked against the mapping's rules, and the gate writes the whole statement from the rule's chain
   * (every label and relationship type quoted from the allowlist). It reads at most `$limit + 1` other ends.
   */
  readonly derivedRule?: { readonly ruleParam: string; readonly entityTypeParam: string };
  /**
   * The supports template's own declaration, for no other template: a statement that finds the chains of one derived rule of the mapping between two nodes, each through a distinct tuple of middle entities. The Cypher is the one
   * marker `@derivedSupport(<rule parameter>)`; the rule is named by ID and the two ends are a list of two references (the rule's `from`, then its `to`) in the parameter `endsParam`, and the gate writes the whole statement
   * from the rule's chain (every label and relationship type quoted from the allowlist). It reads at most `$limit + 1` tuples.
   */
  readonly derivedSupport?: { readonly ruleParam: string; readonly endsParam: string };
  /**
   * The shared-attribute template's own declaration, for no other template: a statement that finds the other entities of the anchor's type that share an attribute node with the anchor. The Cypher is the one marker
   * `@sharedAttribute(<attribute type parameter>)`; the anchor's entity type, the attribute's entity type and the relationship type that joins them are named in the request and checked against the mapping, and the gate writes
   * the whole statement from the mapping row (every name quoted from the allowlist). An attribute node whose stop-list property is true is skipped. The anchor's attribute nodes and the (match, attribute) pairs it reads are
   * bounded by `$countCap + 1`, the matches by `$limit + 1` and the evidence shown for a match by a fixed number. A window is a pair of instants, `windowFrom` and `windowTo`, both given or both left out.
   */
  readonly sharedAttribute?: { readonly entityTypeParam: string; readonly attributeTypeParam: string; readonly viaParam: string };
  /**
   * The edge template's own declaration, for no other template: a statement that reads one stored edge by its type, the entity types of its two ends and its stable ID. The Cypher is the one marker
   * `@edgeLoad(<type parameter>)`, and the gate writes the whole statement from the mapping row that joins the two types by the type and holds a `stable_id`; every name is quoted from the allowlist and the
   * request holds values only. The stable ID is the parameter `stableId` (and `stableInteger`, the integer it can be).
   */
  readonly edgeLoad?: { readonly typeParam: string; readonly fromParam: string; readonly toParam: string; /** The list parameter of stable IDs of a read of many edges of the one type and ends, in place of the parameter `stableId`. */ readonly listParam?: string };
  /**
   * The aggregate templates' own declaration, for no other template: a statement that reads the relationships of one type between two entities that no stable ID tells apart (for a type that has a `stable_id`, those whose ID cannot be used).
   * The Cypher is the one marker `@aggregateRead(<type parameter>)`; the type is named in the request and checked, with the entity types of the two ends (the list parameter `endsParam`, the mapping row's `from`, then its `to`), against the mapping,
   * and the gate writes the whole statement from that row. `sample` returns one row holding both ends and at most `$limit` members as their observed time and mapped properties only (never a relationship, so no element ID); `summary` returns one row
   * with the count and the earliest and latest observed time of every member. Every name is quoted from the allowlist and the request holds values only.
   */
  readonly aggregateRead?: { readonly typeParam: string; readonly endsParam: string; readonly form: 'sample' | 'summary' };
  /** The names of list parameters whose elements are `{ entityType, stableId }` references: for an entity type whose references are keyed the gate reads the token in each element's stable ID before the parameters are checked. */
  readonly referenceLists?: readonly string[];
  /**
   * For a paged template whose cursor position holds the stable ID of an entity: the names of the position fields that carry an entity type and its stable ID. For a keyed entity type the cursor holds the token of the
   * ID and the gate reads it back before the keyset parameters are built, so a cursor never exposes a personal value and the order stays that of the real value.
   */
  readonly referencePositions?: readonly { readonly entityType: string; readonly stableId: string }[];
  /**
   * The names of the parameters that carry an entity type and its stable ID, for a template that reads one node by its reference. For an entity type whose references are keyed the gate reads the token in the
   * stable ID parameter before the parameters are checked, and the statement gets the value; any text that is not a token of this source and entity type is refused.
   */
  readonly referenceParams?: { readonly entityType: string; readonly stableId: string };
  /** The indexes this read needs, so that the gate can find out before the data read that they are there; a template that names none is not guarded. */
  indexNeeds?(params: Params, allowlist: SourceAllowlist): readonly (IndexNeed | RelationshipIndexNeed)[];
  /** True for a request that has nothing to read, such as an empty list of targets or an entity type with no mapped relationship: the gate runs every stage but the read, and the answer has no row. */
  readsNothing?(params: Params, allowlist: SourceAllowlist): boolean;
  /** Where the page after this one starts, from the rows of this page; the gate signs it into the page's `nextCursor`. Only a paged template has one. */
  nextPosition?(rows: readonly Row[], limit: number): CursorPosition | undefined;
  /**
   * For a paged template whose answer counts every hit of its pages so far: the hits one page holds, from its redacted items. The gate adds them to the count the cursor carried and signs the sum into
   * the next cursor, so a later page answers the hits held so far without trusting a number from the caller.
   */
  heldOf?(items: readonly Item[]): number;
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
  /** The evidence properties of each relationship mapping row that has any, with or without a `stable_id`, in the mapping's order: the rows an evidence read may name. */
  readonly evidenceRows: readonly { readonly type: string; readonly from: string; readonly to: string; readonly properties: readonly string[] }[];
  /** The derived rules of the mapping, in its order: the chains a rule run may follow. */
  readonly derivedRules?: readonly { readonly id: string; readonly from: string; readonly to: string; readonly via: readonly string[]; readonly stopListProperty?: string }[];
  /** The relationship rows of the mapping, in its order: the pairs a degree read counts. */
  readonly relationshipRows: readonly { readonly type: string; readonly from: string; readonly to: string; readonly stableId?: string; readonly observedAt?: string; readonly filterable?: readonly string[]; readonly sortable?: readonly string[] }[];
  /** The `filterable` properties of each entity type, by type, in the mapping's order; a type with none is absent. */
  readonly filterableProperties?: ReadonlyMap<string, readonly string[]>;
  /** The `sortable` properties of each entity type, by type; a type with none is absent. */
  readonly sortableProperties?: ReadonlyMap<string, readonly string[]>;
  /** The degree properties each entity type declares, by type; a type with none is absent. */
  readonly degreeProperties?: ReadonlyMap<string, readonly DegreeDeclaration[]>;
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
  /** The most rows a bounded count reads: the relationships of one relationship type and direction of a degree count, or the matches of one facet probe; the source's `heavy_op_threshold`, never the page limit. */
  readonly countCap: number;
  /** The source's `max_hops`: the most hops a template that names hops may read, when its own maximum is not lower. */
  readonly maxHops: number;
  /** The source's read slots: per person, for everyone, and the wait for both. */
  readonly userConcurrency: number;
  readonly sourceConcurrency: number;
  readonly queueWaitMs: number;
  /** The source's circuit breaker rule. */
  readonly breaker: BreakerLimits;
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
  /** Aborted when the client gives up the request; the gate then stops the read and answers nothing. */
  readonly signal?: AbortSignal;
}

export interface GateContext {
  readonly traceId: string;
  readonly principal: Principal;
  readonly system: boolean;
  /** What the read is for, which decides whether it may be the trial read of a recovering source. */
  readonly role: ReadRole;
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
  /** The request's abort signal, passed on to the read; the gate never closes a session itself. */
  readonly signal?: AbortSignal;
}

export interface GatePage {
  readonly items: readonly Item[];
  readonly hasMore: boolean;
  /** Signed for this request; present only when the read found more than the page and the template says where the next one starts. */
  readonly nextCursor?: string;
  /** For a template that counts its hits across pages (`heldOf`): the hits of the earlier pages, from the signed cursor, plus those of this page. */
  readonly held?: number;
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
  /**
   * Reads several pages of one request, one after another under one read lease, all for the same source, person and masking, and answers every page or the failure of any, with nothing partial.
   * Every request is validated (a cursor included) before the first read, one deadline covers them all, and one audit event is written.
   */
  runMany(requests: readonly GateRequest[]): Promise<readonly GatePage[]>;
}

/**
 * Reads the indexes of a source as they are now, with the one fixed schema read of the gate's system runner; it runs nothing else, and only for a principal the policy allows on the
 * source, whatever its checks showed. `'unverified'` when no read is made (the principal is refused, and the run that follows is refused by its own rules) or the login may not list indexes. Any other failure of the read is thrown.
 */
export interface IndexReader {
  read(request: { readonly traceId: string; readonly principal: Principal; readonly sourceId: string; readonly signal?: AbortSignal }): Promise<IndexSnapshot | 'unverified'>;
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
