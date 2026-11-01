export const ROUTE_PERMISSIONS = ['public', 'principal'] as const;

export type RoutePermission = (typeof ROUTE_PERMISSIONS)[number];

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  readonly permission: unknown;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    readonly permission?: RoutePermission;
  }
}

export function isRoutePermission(value: unknown): value is RoutePermission {
  return ROUTE_PERMISSIONS.some((permission) => permission === value);
}

export function routesWithoutPermission(routes: readonly RegisteredRoute[]): readonly RegisteredRoute[] {
  return routes.filter((route) => !isRoutePermission(route.permission));
}
