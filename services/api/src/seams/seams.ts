import type { MeResponse } from '@neburyx/contracts';

export type Principal = MeResponse['principal'];

export interface AuthorizationRequest {
  readonly principal: Principal;
  readonly sourceId: string;
}

export type Decision = { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

export interface PolicyProvider {
  authorizeSource(request: AuthorizationRequest): Promise<Decision>;
}

export type AuditResult = 'success' | 'denied' | 'partial' | 'refused' | 'failed';

export interface AuditEvent {
  readonly actorId: string;
  readonly actorRole: Principal['role'];
  readonly action: string;
  readonly result: AuditResult;
  readonly sourceId?: string;
  readonly traceId: string;
}

export interface AuditSink {
  record(event: AuditEvent): Promise<void>;
}

/** The slot limits of one source, as the gate resolved them for the read. */
export interface ReadLimits {
  /** Reads one person may have in flight on the source. */
  readonly userConcurrency: number;
  /** Reads everyone together may have in flight on the source. */
  readonly sourceConcurrency: number;
  /** How long a read waits, in all, for both of its slots before it is refused as busy. */
  readonly queueWaitMs: number;
}

export interface ReadAccessRequest {
  readonly principal: Principal;
  readonly sourceId: string;
  readonly limits: ReadLimits;
  /** How long a granted lease may be held before it frees itself: a duration, so that a store shared by several copies can count it on its own clock. */
  readonly leaseTtlMs: number;
}

export interface ReadLease {
  /** Frees the lease's slots; a second call, or a call after the lease expired, frees nothing. */
  release(): Promise<void>;
}

export type ReadAdmission =
  | { readonly status: 'granted'; readonly lease: ReadLease }
  | { readonly status: 'busy' }
  | { readonly status: 'unavailable' };

export interface Coordinator {
  acquireRead(request: ReadAccessRequest): Promise<ReadAdmission>;
}

export interface Seams {
  readonly policy: PolicyProvider;
  readonly audit: AuditSink;
  readonly coordinator: Coordinator;
}
