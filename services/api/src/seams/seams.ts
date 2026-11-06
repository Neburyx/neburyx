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

export interface ReadAccessRequest {
  readonly principal: Principal;
  readonly sourceId: string;
}

export interface ReadLease {
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
