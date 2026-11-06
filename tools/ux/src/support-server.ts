import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { openInvestigationRequestSchema, valueOfPathSegment } from '@neburyx/contracts';

export interface SupportServerOptions {
  /** The folder of a built web app. */
  readonly root: string;
  /** The synthetic source profile the pages read; its `sourceId` names the one source the server lists, and its entity types are the ones an investigation can start from. */
  readonly profile: { readonly sourceId: string; readonly entityTypes?: readonly { readonly type: string }[] };
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

const NOT_FOUND = { error: { code: 'NOT_FOUND', message: 'Not found.', retryable: false, traceId: 'tr-support' } };
const INVALID = { error: { code: 'INVALID_REQUEST', message: 'The request is not valid.', retryable: false, traceId: 'tr-support' } };

interface StoredInvestigation {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly caseRef: string | null;
  readonly entityType: string;
  readonly stableId: string;
  readonly createdAt: string;
}

function node(sourceId: string, entityType: string, stableId: string): unknown {
  return {
    ref: { sourceId, entityType, stableId },
    display: { title: `${entityType} ${stableId}`, type: entityType },
    properties: [],
    qualityFlags: [],
    provenanceRefs: [],
    authorization: { canInspect: true, canExport: true },
  };
}

/** An investigation opened with a case reference that starts with this is new when it is opened, and once it exists reads back, and is resumed, as one whose source now points at another database. */
const REPOINTED_CASE_REF = 'repointed';
const isRepointed = (caseRef: string | null): boolean => caseRef?.startsWith(REPOINTED_CASE_REF) === true;

function shown(stored: StoredInvestigation, isNew = false): unknown {
  return {
    id: stored.id,
    sourceId: stored.sourceId,
    title: stored.title,
    caseRef: stored.caseRef,
    status: 'open',
    startingEntity: { entityType: stored.entityType, stableId: stored.stableId },
    sourceState: !isNew && isRepointed(stored.caseRef) ? 'repointed' : 'available',
    createdAt: stored.createdAt,
    lastEditedAt: stored.createdAt,
    version: 1,
  };
}

function draftOf(stored: StoredInvestigation): unknown {
  return {
    version: 1,
    layout: { schemaVersion: 1, layout: 'force', nodes: [{ t: stored.entityType, id: stored.stableId, pinned: false, hidden: false, groupId: null }], edges: [], groups: [] },
    queryContext: { schemaVersion: 1, loaded: { nodes: [{ t: stored.entityType, id: stored.stableId }], edges: [] }, expansions: [], filters: { entityTypes: [], relTypes: [], time: null, properties: [] } },
  };
}

/** The synthetic stand-in for the entity and investigation endpoints: it holds the investigations opened since it started, and an entity named `missing` does not exist. */
function createInvestigations(options: SupportServerOptions) {
  const held = new Map<string, StoredInvestigation>();
  const sourceId = options.profile.sourceId;
  const types = new Set((options.profile.entityTypes ?? []).map((entry) => entry.type));
  const exists = (entityType: string, stableId: string): boolean => types.has(entityType) && stableId !== 'missing';
  return {
    entity(entityType: string, stableId: string, response: ServerResponse): void {
      if (!exists(entityType, stableId)) return json(response, 404, NOT_FOUND);
      json(response, 200, node(sourceId, entityType, stableId));
    },
    read(id: string, response: ServerResponse): void {
      const stored = held.get(id);
      if (stored === undefined) return json(response, 404, NOT_FOUND);
      json(response, 200, { investigation: shown(stored), draft: draftOf(stored) });
    },
    open(body: unknown, response: ServerResponse): void {
      const parsed = openInvestigationRequestSchema.safeParse(body);
      if (!parsed.success) return json(response, 400, INVALID);
      const { entity, caseRef = null } = parsed.data;
      const { entityType, stableId } = entity;
      if (parsed.data.sourceId !== sourceId || entity.sourceId !== sourceId) return json(response, 400, INVALID);
      if (!exists(entityType, stableId)) return json(response, 404, NOT_FOUND);
      const existing = caseRef === null ? undefined : [...held.values()].find((stored) => stored.caseRef === caseRef && stored.entityType === entityType && stored.stableId === stableId);
      if (existing !== undefined) return json(response, 200, { investigation: shown(existing), created: false, ...(isRepointed(existing.caseRef) ? {} : { entity: node(sourceId, entityType, stableId) }) });
      const stored: StoredInvestigation = { id: randomUUID(), sourceId, title: `${entityType} ${stableId}`, caseRef, entityType, stableId, createdAt: new Date().toISOString() };
      held.set(stored.id, stored);
      json(response, 201, { investigation: shown(stored, true), created: true, entity: node(sourceId, entityType, stableId) });
    },
  };
}

function api(path: string, options: SupportServerOptions, response: ServerResponse): void {
  const id = options.profile.sourceId;
  if (path === '/healthz' || path === '/readyz') return json(response, 200, { status: 'ok' });
  if (path === '/v1/me') return json(response, 200, me(id));
  if (path === '/v1/sources') return json(response, 200, { items: [source(id)], nextCursor: null });
  if (path === `/v1/sources/${encodeURIComponent(id)}/profile`) return json(response, 200, options.profile);
  json(response, 404, { error: { code: 'NOT_FOUND' } });
}

async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return null;
  }
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
  const investigations = createInvestigations(options);
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      const isApi = API_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
      if (request.method === 'POST' && path === '/v1/investigations') return investigations.open(await bodyOf(request), response);
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
      if (isApi) {
        const parts = path.split('/').map((part) => decodeURIComponent(part));
        const [, , kind, first, second, third] = parts;
        if (kind === 'entities' && parts.length === 6 && first === options.profile.sourceId && second !== undefined && third !== undefined) {
          const entityType = valueOfPathSegment(second);
          const stableId = valueOfPathSegment(third);
          return entityType === undefined || stableId === undefined ? json(response, 400, INVALID) : investigations.entity(entityType, stableId, response);
        }
        if (kind === 'investigations' && parts.length === 4 && first !== undefined) return investigations.read(first, response);
        return api(path, options, response);
      }
      const found = (await file(root, path)) ?? (extname(path) === '' ? await file(root, 'index.html') : undefined);
      if (found === undefined) return json(response, 404, { error: { code: 'NOT_FOUND' } });
      response.writeHead(200, { 'content-type': found.type });
      response.end(found.body);
    })().catch(() => json(response, 500, { error: { code: 'SERVER_ERROR' } }));
  });
}
