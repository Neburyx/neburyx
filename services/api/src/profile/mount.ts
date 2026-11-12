import type { ProfileExtension } from '@neburyx/contracts';
import type { FastifyInstance } from 'fastify';
import type { AppStore } from '../app-store.js';
import { AppError } from '../errors.js';

export function mountExtensionRoutes(app: FastifyInstance, extension: ProfileExtension, store: Pick<AppStore, 'current'>): void {
  for (const group of extension.routeGroups) {
    for (const route of group.routes) {
      app.route({
        method: route.method,
        url: route.url,
        exposeHeadRoute: false,
        config: { permission: route.permission },
        handler: async (request) => {
          const { principal } = await store.current();
          const reply = await route.handler({ principalId: principal.id });
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
