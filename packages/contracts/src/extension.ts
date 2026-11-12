import type { ZodType } from 'zod';

export type ExtensionRoutePermission = 'public' | 'principal';

export interface ExtensionRequest {
  readonly principalId: string;
}

export interface ExtensionRoute {
  readonly method: 'GET';
  readonly url: string;
  readonly permission: ExtensionRoutePermission;
  readonly responseSchema: ZodType;
  readonly handler: (request: ExtensionRequest) => Promise<unknown>;
}

export interface ExtensionRouteGroup {
  readonly routes: readonly ExtensionRoute[];
}

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
}
