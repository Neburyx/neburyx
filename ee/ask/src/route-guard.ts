import { ExtensionRefusal, type AuditEvent, type ExtensionRoute, type ExtensionRouteGroup } from '@neburyx/contracts';

export const ROUTE_REFUSED_ACTION = 'ai.route_refused';

function guardedRoute(route: ExtensionRoute): ExtensionRoute {
  return {
    ...route,
    async handler(request) {
      if (request.previewOn) return route.handler(request);
      const event: AuditEvent = { actorId: request.principalId, actorRole: request.principalRole, action: ROUTE_REFUSED_ACTION, result: 'refused', traceId: request.traceId };
      let audited = true;
      try {
        await request.audit.record(event);
      } catch {
        // the refusal does not depend on its own audit event; the mount logs that it was not written
        audited = false;
      }
      throw new ExtensionRefusal({ code: 'ACCESS_DENIED', reason: 'ai-preview-off', audited });
    },
  };
}

/** Every route of an AI route group, wrapped so that a call is refused, and the refusal audited, when the preview switch is not on; the wrapped handler never runs then. */
export function guardAiRouteGroup(group: ExtensionRouteGroup): ExtensionRouteGroup {
  return { ...group, routes: group.routes.map(guardedRoute) };
}
