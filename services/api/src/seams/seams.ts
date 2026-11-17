import type { AskClassifier, AuditSink, CaseSummarizer, MeResponse } from '@neburyx/contracts';

export type Principal = MeResponse['principal'];

interface AuthorizationRequest {
  readonly principal: Principal;
  readonly sourceId: string;
}

export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface PolicyProvider {
  authorizeSource(request: AuthorizationRequest): Promise<Decision>;
}

export type { AuditEvent, AuditResult, AuditSink } from '@neburyx/contracts';

/** The slot limits of one source, as the gate resolved them for the read. */
interface ReadLimits {
  /** Reads one person may have in flight on the source. */
  readonly userConcurrency: number;
  /** Reads everyone together may have in flight on the source. */
  readonly sourceConcurrency: number;
  /** How long a read waits, in all, for both of its slots before it is refused as busy. */
  readonly queueWaitMs: number;
}

/** What a read is for: the data read of a person's request, the index-list read made for such a request, or a read nobody asked for (scheduled pings, start-up). The breaker lets only a data read decide whether a recovering source is well again. */
export type ReadRole = 'data' | 'index' | 'background';

/** Who a read is for: a person's own request, or an AI feature (Ask, the case summary, the assistant). AI reads share only a part of each pool of slots. */
export type ReadOrigin = 'manual' | 'ai';

/** How a read ended, as far as the circuit breaker is concerned: rows came back, the source did not answer within the time it was given, or anything else (cancelled, failed, never ran). */
export type ReadOutcome = 'answered' | 'timeout' | 'other';

/** The trip rule of one source: `failures` timeouts within `windowMs` open the breaker, and it stays open for `cooldownMs`. */
export interface BreakerLimits {
  readonly failures: number;
  readonly windowMs: number;
  readonly cooldownMs: number;
}

export interface ReadAccessRequest {
  readonly principal: Principal;
  readonly sourceId: string;
  readonly limits: ReadLimits;
  /** Every caller says what its read is for. */
  readonly role: ReadRole;
  /** Absent means a person's own read. */
  readonly origin?: ReadOrigin;
  /** The source's trip rule; a coordinator without a breaker ignores it. */
  readonly breaker?: BreakerLimits;
  /** How long a granted lease may be held before it frees itself: a duration, so that a store shared by several copies can count it on its own clock. */
  readonly leaseTtlMs: number;
  /** Aborted when the request is cancelled: a read that waits for a slot then leaves the queue and is answered `cancelled`, holding nothing. */
  readonly signal?: AbortSignal;
}

export interface ReadLease {
  /** Frees the lease's slots; a second call, or a call after the lease expired, frees nothing. The outcome is what the circuit breaker learns of the read; none counts as `other`. */
  release(outcome?: ReadOutcome): Promise<void>;
}

export type ReadAdmission =
  | { readonly status: 'granted'; readonly lease: ReadLease }
  | { readonly status: 'busy' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unavailable'; readonly reason?: 'repeated-timeouts'; readonly retryAfterMs?: number };

export interface Coordinator {
  acquireRead(request: ReadAccessRequest): Promise<ReadAdmission>;
}

export type { AskClassifier, CaseSummarizer } from '@neburyx/contracts';

export interface Seams {
  readonly policy: PolicyProvider;
  /** Where an ordinary event goes: a writer that records an event does not wait for it to be stored and does not handle its failure, because this member queues the event and never throws. */
  readonly audit: AuditSink;
  /** Where an event of a privileged action goes: written directly and awaited, so the caller sees a failure. Absent, the `audit` member is used, which is right only for a seam that has no queue. */
  readonly privilegedAudit?: AuditSink;
  readonly coordinator: Coordinator;
  /** Where Ask classifies a question; absent, the application uses the Community default, which says Ask is unavailable. */
  readonly askClassifier?: AskClassifier;
  /** Where the case summary is drafted; absent, the application uses the Community default, which says the summary is unavailable. */
  readonly caseSummarizer?: CaseSummarizer;
}

export function privilegedAuditOf(seams: Pick<Seams, 'audit' | 'privilegedAudit'>): AuditSink {
  return seams.privilegedAudit ?? seams.audit;
}
