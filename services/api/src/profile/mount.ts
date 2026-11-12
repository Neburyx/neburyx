import { parseExtensionRefusal, type AuditSink, type ProfileExtension } from '@neburyx/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppStore } from '../app-store.js';
import { AppError } from '../errors.js';

export interface ExtensionMount {
  readonly previewOn: boolean;
  readonly audit: AuditSink;
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
          let reply: unknown;
          try {
            reply = await route.handler({ principalId: principal.id, principalRole: principal.role, previewOn: mount.previewOn, traceId: request.id, audit: mount.audit });
          } catch (error) {
            const refusal = parseExtensionRefusal(error);
            if (refusal === undefined) {
              request.log.error({ event: 'extension.handler_failed', extension: extension.name }, 'an extension handler failed');
              throw new AppError('INTERNAL_ERROR');
            }
            if (!refusal.audited) request.log.warn({ event: 'extension.audit_failed', extension: extension.name }, 'the audit event of a refusal could not be written');
            throw new AppError(refusal.code, { reason: refusal.reason });
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
