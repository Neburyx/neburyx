import type { ZodType } from 'zod';
import type { AiSettings } from './ai.js';

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

export type ConfigureOutcome = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

export interface ProfileExtension {
  readonly name: string;
  readonly routeGroups: readonly ExtensionRouteGroup[];
  readonly migrationsDirectory?: string;
  readonly configure?: (settings: AiSettings, env: Readonly<Record<string, string | undefined>>) => Promise<ConfigureOutcome>;
}
