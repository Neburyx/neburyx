import { parseExtensionRefusal, type AskPlanner, type AuditSink, type ExtensionRequest, type ProfileExtension } from '@neburyx/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppStore } from '../app-store.js';
import { AppError } from '../errors.js';
import type { Principal } from '../seams/seams.js';

export interface ExtensionMount {
  readonly previewOn: boolean;
  readonly audit: AuditSink;
  readonly askPlanner: AskPlanner;
  /** Signs previews; absent, the plan route refuses. */
  readonly previewMac?: ExtensionRequest['previewMac'];
  /** The caller's policy version for a source. */
  readonly policyVersionOf?: ExtensionRequest['policyVersionOf'];
  /** The search and lookup of a source for the caller of one request, read through the gate; absent, the plan route refuses. */
  readonly askEntityToolsFor?: (context: { readonly principal: Principal; readonly traceId: string }) => ExtensionRequest['askEntityTools'];
}

export function mountExtensionRoutes(app: FastifyInstance, extension: ProfileExtension, store: Pick<AppStore, 'current'>, mount: ExtensionMount): void {
  for (const group of extension.routeGroups) {
    for (const route of group.routes) {
      app.route({
        method: route.method,
        url: route.url,
        exposeHeadRoute: false,
        config: { permission: route.permission },
        handler: async (request) => {
          const { principal } = await store.current();
          let body: unknown;
          // with the switch off the route group refuses before it reads the body, so a refusal is audited whatever the body is
          if (route.requestSchema !== undefined && mount.previewOn) {
            const parsedBody = route.requestSchema.safeParse(request.body);
            if (!parsedBody.success) throw new AppError('INVALID_REQUEST');
            body = parsedBody.data;
          }
          let reply: unknown;
          try {
            const askEntityTools = mount.askEntityToolsFor?.({ principal, traceId: request.id });
            reply = await route.handler({
              principalId: principal.id,
              principalRole: principal.role,
              previewOn: mount.previewOn,
              traceId: request.id,
              audit: mount.audit,
              askPlanner: mount.askPlanner,
              ...(mount.previewMac === undefined ? {} : { previewMac: mount.previewMac }),
              ...(mount.policyVersionOf === undefined ? {} : { policyVersionOf: mount.policyVersionOf }),
              ...(askEntityTools === undefined ? {} : { askEntityTools }),
              ...(body === undefined ? {} : { body }),
            });
          } catch (error) {
            const refusal = parseExtensionRefusal(error);
            // the application's own tools throw its errors: they keep their code
            if (refusal === undefined && error instanceof AppError) throw error;
            if (refusal === undefined) {
              request.log.error({ event: 'extension.handler_failed', extension: extension.name }, 'an extension handler failed');
              throw new AppError('INTERNAL_ERROR');
            }
            if ('audited' in refusal && !refusal.audited) request.log.warn({ event: 'extension.audit_failed', extension: extension.name }, 'the audit event of a refusal could not be written');
            throw new AppError(refusal.code, 'reason' in refusal ? { reason: refusal.reason } : 'timeoutMs' in refusal ? { timeoutMs: refusal.timeoutMs } : undefined);
          }
          const parsed = route.responseSchema.safeParse(reply);
          if (!parsed.success) {
            request.log.error({ event: 'extension.reply_invalid', extension: extension.name }, 'an extension reply did not match its schema');
            throw new AppError('INTERNAL_ERROR');
          }
          return parsed.data;
        },
      });
    }
  }
}
