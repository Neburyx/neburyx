import { createHash } from 'node:crypto';
import { IDEMPOTENCY_KEY_PATTERN } from '@neburyx/contracts';
import type { ExportStore } from '../db/exports-repository.js';
import { AppError } from '../errors.js';
import { canonicalJson } from '../gate/cursor/binding.js';
import type { PolicyProvider, Principal } from '../seams/seams.js';

export const IDEMPOTENT_REPLAY_HEADER = 'idempotent-replay';
const SERVER_ERROR = 500;

/** `undefined` when the header is missing or malformed. */
export function idempotencyKeyOf(header: unknown): string | undefined {
  return typeof header === 'string' && IDEMPOTENCY_KEY_PATTERN.test(header) ? header : undefined;
}

/** A SHA-256 of the method, the concrete path, the query string and the canonical JSON body, so the same key with another request is told apart. */
export function fingerprintOf(request: { readonly method: string; readonly path: string; readonly query: string; readonly body: unknown }): string {
  return createHash('sha256').update(`${request.method}\n${request.path}\n${request.query}\n${canonicalJson(request.body ?? null)}`).digest('hex');
}

export interface Answer {
  readonly statusCode: number;
  readonly body: unknown;
  readonly replayed: boolean;
}

interface Deps {
  readonly store: Pick<ExportStore, 'startIdempotent' | 'finishIdempotent' | 'forgetIdempotent'>;
  readonly policy: PolicyProvider;
  readonly policyVersion: (sourceId: string) => string;
}

/**
 * Runs `work` once per person and key: a repeat with the same request returns the first answer, another request or a call still running is `CONFLICT`, and a repeat after the person's access to the
 * source was revoked is `ACCESS_DENIED` and after the policy changed `CONFLICT`. A first call that ended in a server error is forgotten, so a retry runs again.
 */
export async function runOnce(
  deps: Deps,
  call: { readonly principal: Principal; readonly sourceId: string; readonly stillReadable: () => Promise<boolean>; readonly key: string; readonly fingerprint: string },
  work: () => Promise<Answer>,
  describeFailure: (error: unknown) => { readonly statusCode: number; readonly body: unknown } | undefined,
): Promise<Answer> {
  const policyVersion = deps.policyVersion(call.sourceId);
  const started = await deps.store.startIdempotent({ userId: call.principal.id, key: call.key, fingerprint: call.fingerprint, policyVersion });
  if (started.outcome === 'conflict') throw new AppError('CONFLICT');
  if (started.outcome === 'replay') {
    const decision = await deps.policy.authorizeSource({ principal: call.principal, sourceId: call.sourceId });
    if (!decision.allowed || !(await call.stillReadable())) throw new AppError('ACCESS_DENIED');
    if (started.policyVersion !== policyVersion) throw new AppError('CONFLICT');
    return { statusCode: started.statusCode, body: started.response, replayed: true };
  }
  try {
    const answer = await work();
    await deps.store.finishIdempotent(call.principal.id, call.key, answer.statusCode, answer.body);
    return answer;
  } catch (error) {
    const failure = describeFailure(error);
    if (failure === undefined || failure.statusCode >= SERVER_ERROR) {
      await deps.store.forgetIdempotent(call.principal.id, call.key).catch(() => undefined);
      throw error;
    }
    await deps.store.finishIdempotent(call.principal.id, call.key, failure.statusCode, failure.body).catch(() => undefined);
    throw error;
  }
}
