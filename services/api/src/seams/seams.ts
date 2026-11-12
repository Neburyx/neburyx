import type { AuditSink, MeResponse } from '@neburyx/contracts';

export type Principal = MeResponse['principal'];

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly sourceId: string;
}

export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface PolicyProvider {
  authorizeSource(request: AuthorizationRequest): Promise<Decision>;
}

export type { AuditEvent, AuditResult, AuditSink } from '@neburyx/contracts';

/** The slot limits of one source, as the gate resolved them for the read. */
export interface ReadLimits {
  /** Reads one person may have in flight on the source. */
  readonly userConcurrency: number;
  /** Reads everyone together may have in flight on the source. */
  readonly sourceConcurrency: number;
  /** How long a read waits, in all, for both of its slots before it is refused as busy. */
  readonly queueWaitMs: number;
}

/** What a read is for: the data read of a person's request, the index-list read made for such a request, or a read nobody asked for (scheduled pings, start-up). The breaker lets only a data read decide whether a recovering source is well again. */
export type ReadRole = 'data' | 'index' | 'background';

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

export interface Seams {
  readonly policy: PolicyProvider;
  readonly audit: AuditSink;
  readonly coordinator: Coordinator;
}
