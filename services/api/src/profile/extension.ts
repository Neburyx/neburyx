import type { ProfileExtension } from '@neburyx/contracts';
import { isRoutePermission } from '../permissions.js';

export interface ExtensionLoader {
  readonly load: () => Promise<ProfileExtension>;
}

export type ExtensionLoad = { readonly ok: true; readonly extension: ProfileExtension } | { readonly ok: false; readonly message: string; readonly cause?: string };

const API_URL_PREFIX = '/v1/';

export const NO_EXTENSION_MESSAGE = 'invalid configuration: the enterprise profile is on and this build has no enterprise code';
export const EXTENSION_LOAD_FAILED_MESSAGE = 'the enterprise code could not be loaded';
export const EXTENSION_LOGGER_FAILED_MESSAGE = 'the enterprise code could not take the logger';
export const EXTENSION_CONFIGURE_FAILED_MESSAGE = 'the enterprise code could not be configured';

/** Only the code or the name of an error, never its message, which may hold a path or a value. */
export function causeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : error instanceof Error ? error.name : undefined;
}

let registered: ExtensionLoader | undefined;

/** Called by the entry script of an image that carries enterprise code; Community code only reads the registry. */
export function registerProfileExtension(loader: ExtensionLoader): void {
  registered = loader;
}

export function registeredExtensionLoader(): ExtensionLoader | undefined {
  return registered;
}

export function clearRegisteredExtension(): void {
  registered = undefined;
}

export async function loadProfileExtension(loader: ExtensionLoader | undefined): Promise<ExtensionLoad> {
  if (loader === undefined) return { ok: false, message: NO_EXTENSION_MESSAGE };
  let extension: ProfileExtension;
  try {
    extension = await loader.load();
  } catch (error) {
    const cause = causeOf(error);
    return { ok: false, message: EXTENSION_LOAD_FAILED_MESSAGE, ...(cause === undefined ? {} : { cause }) };
  }
  for (const group of extension.routeGroups) {
    for (const route of group.routes) {
      if (route.method !== 'GET' && route.method !== 'POST') {
        return { ok: false, message: `the enterprise route ${String(route.method)} ${route.url} has a method other than GET or POST` };
      }
      if ((route.method === 'POST') !== (route.requestSchema !== undefined)) {
        return { ok: false, message: `the enterprise route ${route.method} ${route.url} ${route.method === 'POST' ? 'has no request schema' : 'has a request schema but is not a POST'}` };
      }
      if (!isRoutePermission(route.permission)) {
        return { ok: false, message: `the enterprise route ${route.method} ${route.url} has no known permission` };
      }
      if (!route.url.startsWith(API_URL_PREFIX)) {
        return { ok: false, message: `the enterprise route ${route.method} ${route.url} is outside ${API_URL_PREFIX}` };
      }
    }
  }
  return { ok: true, extension };
}
