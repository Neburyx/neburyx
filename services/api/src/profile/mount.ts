import { parseExtensionRefusal, type AskClassifier, type CaseSummarizer, type ExtensionRefusalFields, type AuditSink, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppStore } from '../app-store.js';
import { AppError, errorResponse, errorStatus } from '../errors.js';
import { IDEMPOTENT_REPLAY_HEADER, fingerprintOf, idempotencyKeyOf, runOnce } from '../exports/idempotency.js';
import { communityAskClassifier, communityCaseSummarizer } from '../seams/community-seams.js';
import type { PolicyProvider, Principal } from '../seams/seams.js';

/** What an extension route gets as its abort signal when the application gave no way to tell that the client gave up. */
const NEVER_ABORTED = new AbortController();

/** What a route that declares itself idempotent is run with: the store of the keys, the policy of the source and its version, and whether the person may still read the source. */
interface ExtensionIdempotency {
  readonly store: Pick<AppStore, 'startIdempotent' | 'finishIdempotent' | 'forgetIdempotent'>;
  readonly policy: PolicyProvider;
  readonly policyVersion: (sourceId: string) => string;
  readonly stillReadable: (sourceId: string) => Promise<boolean>;
}

export interface ExtensionMount {
  readonly idempotency?: ExtensionIdempotency;
  readonly previewOn: boolean;
  readonly audit: AuditSink;
  readonly askClassifier: AskClassifier;
  readonly caseSummarizer: CaseSummarizer;
  /** Signs a text (the Continue token); absent, a route that needs it refuses. */
  readonly signText?: ExtensionRequest['signText'];
  /** Reads the elements of a view again for one request, bound to its caller, its trace ID and its abort signal; absent, a route that reads elements refuses. */
  readonly readElementsFor?: (context: { readonly principal: Principal; readonly traceId: string; readonly signal: AbortSignal }) => ExtensionRequest['readElements'];
  /** Whether the caller still has the investigation of a view and its source, for one request; absent, a route that asks it refuses. */
  readonly investigationReadableFor?: (context: { readonly principal: Principal; readonly traceId: string }) => ExtensionRequest['investigationReadable'];
  /** The runner of Ask for one request, bound to its caller, its trace ID and its abort signal; absent, a route that runs Ask refuses. */
  readonly askRunnerFor?: (context: { readonly principal: Principal; readonly traceId: string; readonly signal: AbortSignal }) => ExtensionRequest['askRunner'];
  /** Whether the caller may read a source, for one request; absent, a route that asks it refuses. */
  readonly askSourceReadableFor?: (context: { readonly principal: Principal; readonly traceId: string }) => ExtensionRequest['askSourceReadable'];
  /** The saved patterns the caller may run on a source, for one request; absent, no saved pattern is offered to Ask. */
  readonly askPatternsFor?: (context: { readonly principal: Principal; readonly traceId: string }) => ExtensionRequest['askPatterns'];
  /** One saved pattern by its id, for one request; absent, a run that names a pattern is refused. */
  readonly askPatternFindFor?: (context: { readonly principal: Principal; readonly traceId: string }) => ExtensionRequest['askPatternFind'];
  /** The signal that is aborted when the client gives up the request. */
  readonly signalOf?: (request: FastifyRequest) => AbortSignal;
}

export function mountExtensionRoutes(app: FastifyInstance, extension: ProfileExtension, store: Pick<AppStore, 'current'>, mount: ExtensionMount): void {
  for (const group of extension.routeGroups) {
    for (const route of group.routes) {
      app.route({
        method: route.method,
        url: route.url,
        exposeHeadRoute: false,
        config: { permission: route.permission },
        handler: async (request, replyOut) => {
          const { principal } = await store.current();
          let body: unknown;
          // with the switch off the route group refuses before it reads the body, so a refusal is audited whatever the body is
          if (route.requestSchema !== undefined && mount.previewOn) {
            const parsedBody = route.requestSchema.safeParse(request.body);
            if (!parsedBody.success) throw new AppError('INVALID_REQUEST');
            body = parsedBody.data;
          }
          const build = (): ExtensionRequest => {
            const askSourceReadable = mount.askSourceReadableFor?.({ principal, traceId: request.id });
            const readElements = mount.signalOf === undefined ? undefined : mount.readElementsFor?.({ principal, traceId: request.id, signal: mount.signalOf(request) });
            const investigationReadable = mount.investigationReadableFor?.({ principal, traceId: request.id });
            const askPatterns = mount.askPatternsFor?.({ principal, traceId: request.id });
            const askPatternFind = mount.askPatternFindFor?.({ principal, traceId: request.id });
            const askRunner = mount.signalOf === undefined ? undefined : mount.askRunnerFor?.({ principal, traceId: request.id, signal: mount.signalOf(request) });
            return {
              principalId: principal.id,
              principalRole: principal.role,
              previewOn: mount.previewOn,
              traceId: request.id,
              audit: mount.audit,
              askClassifier: mount.askClassifier !== communityAskClassifier ? mount.askClassifier : (extension.askClassifier?.() ?? mount.askClassifier),
              caseSummarizer: mount.caseSummarizer !== communityCaseSummarizer ? mount.caseSummarizer : (extension.caseSummarizer?.() ?? mount.caseSummarizer),
              signal: mount.signalOf?.(request) ?? NEVER_ABORTED.signal,
              ...(mount.idempotency === undefined ? {} : { policyVersion: mount.idempotency.policyVersion }),
              ...(mount.signText === undefined ? {} : { signText: mount.signText }),
              ...(askSourceReadable === undefined ? {} : { askSourceReadable }),
              ...(askPatterns === undefined ? {} : { askPatterns }),
              ...(askPatternFind === undefined ? {} : { askPatternFind }),
              ...(askRunner === undefined ? {} : { askRunner }),
              ...(readElements === undefined ? {} : { readElements }),
              ...(investigationReadable === undefined ? {} : { investigationReadable }),
              ...(body === undefined ? {} : { body }),
            };
          };
          const produce = async (): Promise<unknown> => {
          let reply: unknown;
          try {
            reply = await route.handler(build());
          } catch (error) {
            const refusal = parseExtensionRefusal(error);
            // the application's own tools throw its errors: they keep their code
            if (refusal === undefined && error instanceof AppError) throw error;
            if (refusal === undefined) {
              request.log.error({ event: 'extension.handler_failed', extension: extension.name }, 'an extension handler failed');
              throw new AppError('INTERNAL_ERROR');
            }
            if ('audited' in refusal && !refusal.audited) request.log.warn({ event: 'extension.audit_failed', extension: extension.name }, 'the audit event of a refusal could not be written');
            const details = detailsOfRefusal(refusal);
            // an unavailable source gives its reason as the tag of the error, which is where the answer reads it from
            if (refusal.code === 'SOURCE_UNAVAILABLE') throw new AppError(refusal.code, details, refusal.reason);
            throw new AppError(refusal.code, details);
          }
          const parsed = route.responseSchema.safeParse(reply);
          if (!parsed.success) {
            request.log.error({ event: 'extension.reply_invalid', extension: extension.name }, 'an extension reply did not match its schema');
            throw new AppError('INTERNAL_ERROR');
          }
          return parsed.data;
          };
          const { idempotency } = mount;
          if (route.idempotent === undefined || idempotency === undefined || !mount.previewOn) return produce();
          const queryAt = request.url.indexOf('?');
          if (queryAt >= 0) throw new AppError('INVALID_REQUEST');
          const path = request.url;
          const query = '';
          const key = idempotencyKeyOf(request.headers['idempotency-key']);
          if (key === undefined) throw new AppError('INVALID_REQUEST');
          const sourceId = route.idempotent.sourceOf(body);
          const { recheck, retryable } = route.idempotent;
          const answer = await runOnce(
            { store: idempotency.store, policy: idempotency.policy, policyVersion: idempotency.policyVersion },
            {
              principal,
              sourceId,
              key,
              fingerprint: fingerprintOf({ method: route.method, path: path ?? '', query, body: request.body }),
              stillReadable: async () => (await idempotency.stillReadable(sourceId)) && (recheck === undefined || (await recheck(build()))),
            },
            async () => {
              const made = await produce();
              return { statusCode: 200, body: made, replayed: false, forget: retryable?.(made) === true };
            },
            (error) => (error instanceof AppError && error.code !== 'RATE_LIMITED' ? { statusCode: errorStatus(error.code), body: errorResponse(error.code, request.id, error.details) } : undefined),
          );
          if (answer.replayed) replyOut.header(IDEMPOTENT_REPLAY_HEADER, 'true');
          return replyOut.code(answer.statusCode).send(answer.body);
        },
      });
    }
  }
}

/** The details a refusal names: only the reason and the figures it holds, which `errorResponse` then cuts to what the error model allows for its code. */
function detailsOfRefusal(refusal: ExtensionRefusalFields): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {};
  for (const key of ['reason', 'timeoutMs', 'retryAfterMs', 'maxPage', 'maxHops', 'pathResultsCap'] as const) if (key in refusal) details[key] = (refusal as Record<string, unknown>)[key];
  return Object.keys(details).length === 0 ? undefined : details;
}
