import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';

export interface SupportServerOptions {
  /** The folder of a built web app. */
  readonly root: string;
  /** The synthetic source profile the pages read; its `sourceId` names the one source the server lists. */
  readonly profile: { readonly sourceId: string };
}

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.md': 'text/markdown; charset=utf-8',
};

const API_PREFIXES = ['/v1', '/healthz', '/readyz'];

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function me(sourceId: string): unknown {
  return {
    principal: { id: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d', displayName: 'Local user', role: 'administrator' },
    edition: 'community',
    identityMode: 'none',
    sources: [{ sourceId, viewSensitive: false, synthetic: true }],
  };
}

function source(sourceId: string): unknown {
  return { id: sourceId, alias: sourceId, state: 'connected', stateReason: null, readOnly: true, synthetic: true, lastTestAt: null, lastTest: null, mappingSummary: { entityTypes: 4, relationshipTypes: 6, derivedRules: 2 } };
}

function api(path: string, options: SupportServerOptions, response: ServerResponse): void {
  const id = options.profile.sourceId;
  if (path === '/healthz' || path === '/readyz') return json(response, 200, { status: 'ok' });
  if (path === '/v1/me') return json(response, 200, me(id));
  if (path === '/v1/sources') return json(response, 200, { items: [source(id)], nextCursor: null });
  if (path === `/v1/sources/${encodeURIComponent(id)}/profile`) return json(response, 200, options.profile);
  json(response, 404, { error: { code: 'NOT_FOUND' } });
}

async function file(root: string, path: string): Promise<{ readonly body: Buffer; readonly type: string } | undefined> {
  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  const found = await stat(target).catch(() => undefined);
  if (found === undefined || !found.isFile()) return undefined;
  return { body: await readFile(target), type: TYPES[extname(target)] ?? 'application/octet-stream' };
}

/** Answers the few API reads the pages make with synthetic bodies and serves a built web app, with the app's navigation fallback for a path that is not a file. */
export function createSupportServer(options: SupportServerOptions): Server {
  const root = normalize(options.root);
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      if (API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return api(path, options, response);
      const found = (await file(root, path)) ?? (extname(path) === '' ? await file(root, 'index.html') : undefined);
      if (found === undefined) return json(response, 404, { error: { code: 'NOT_FOUND' } });
      response.writeHead(200, { 'content-type': found.type });
      response.end(found.body);
    })().catch(() => json(response, 500, { error: { code: 'SERVER_ERROR' } }));
  });
}
