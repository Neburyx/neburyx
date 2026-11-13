import type { IncomingMessage, ServerResponse } from 'node:http';
import { CONFLICT_ENTRIES, ERROR_TABLE, changePatternRequestSchema, savePatternRequestSchema } from '@neburyx/contracts';

const json = (response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
};

const STATUS: Readonly<Record<string, number>> = { INVALID_REQUEST: 400, ACCESS_DENIED: 403, NOT_FOUND: 404, CONFLICT: 409 };
const ENTRY: Readonly<Record<string, { message: string; retryable: boolean }>> = {
  INVALID_REQUEST: ERROR_TABLE.INVALID_REQUEST,
  ACCESS_DENIED: ERROR_TABLE.ACCESS_DENIED,
  NOT_FOUND: ERROR_TABLE.NOT_FOUND,
  CONFLICT: ERROR_TABLE.CONFLICT,
};
const refuse = (response: ServerResponse, code: keyof typeof STATUS & string): void =>
  json(response, STATUS[code] ?? 400, { error: { code, message: ENTRY[code]?.message ?? code, retryable: ENTRY[code]?.retryable ?? false, traceId: 'tr-support' } });
/** A name another of the person's patterns on the source already has: a CONFLICT with its own reason, as the API answers. */
const refuseNameTaken = (response: ServerResponse): void =>
  json(response, 409, { error: { code: 'CONFLICT', ...CONFLICT_ENTRIES['pattern-name-taken'], traceId: 'tr-support', details: { reason: 'pattern-name-taken' } } });

type Anchor = { readonly entityType: string; readonly stableId: string };

interface Stored {
  readonly id: string;
  readonly sourceId: string;
  name: string;
  definition: Record<string, unknown>;
  anchor: Anchor | null;
  visibility: 'private' | 'shared';
  version: number;
  readonly owner: 'me' | 'other';
  readonly unavailable: boolean;
  readonly createdAt: string;
}

const DEFINITION = { anchorType: 'account', steps: [{ relationshipTypes: ['USES_DEVICE'], direction: 'out', arrivesAt: 'device' }] };
const AT = '2026-11-12T10:00:00.000Z';
const id = (n: number): string => `0192f000-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** The patterns the stand-in holds at the start and after a reset: one of the person's own that holds its starting entity, one shared by another person, and one of the person's own that the mapping can no longer run. */
const seed = (): Stored[] => [
  { id: id(1), sourceId: 'banking-demo', name: 'Device ring', definition: DEFINITION, anchor: { entityType: 'account', stableId: 'AC-1' }, visibility: 'private', version: 1, owner: 'me', unavailable: false, createdAt: AT },
  { id: id(2), sourceId: 'banking-demo', name: 'Shared by Pat', definition: DEFINITION, anchor: null, visibility: 'shared', version: 1, owner: 'other', unavailable: false, createdAt: AT },
  { id: id(3), sourceId: 'banking-demo', name: 'Retired pattern', definition: DEFINITION, anchor: null, visibility: 'private', version: 1, owner: 'me', unavailable: true, createdAt: AT },
];

const listedOf = (item: Stored) => ({
  id: item.id,
  sourceId: item.sourceId,
  name: item.name,
  askForStartingEntity: item.anchor === null,
  anchor: item.anchor,
  visibility: item.visibility,
  lastRunAt: null,
  createdAt: item.createdAt,
  updatedAt: AT,
  version: item.version,
  kind: 'definition',
  definition: item.definition,
  owner: { name: item.owner === 'me' ? 'You' : 'Pat' },
  ownedByYou: item.owner === 'me',
  availability: item.unavailable ? { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] } : { status: 'available' },
});

const storedOf = (item: Stored) => {
  const { owner: _owner, availability: _availability, ownedByYou: _own, ...rest } = listedOf(item);
  return rest;
};

/**
 * The saved-pattern routes of the stand-in, in memory: a list of the person's own and others' shared patterns, save, change with the version, delete, copy and run. The run is the pattern run of the stand-in over the stored definition,
 * except for the pattern the mapping can no longer run, which answers `unavailable`. `POST /__support/reset` puts the three seeded patterns back.
 */
export function createSavedPatterns(runPattern: (body: unknown, response: ServerResponse, request: IncomingMessage) => Promise<void>) {
  let items = seed();
  let next = 100;
  const visible = (item: Stored): boolean => item.owner === 'me' || item.visibility === 'shared';
  const find = (given: string): Stored | undefined => items.find((item) => item.id === given && visible(item));
  const nameTaken = (sourceId: string, name: string, except: Stored | undefined): boolean => items.some((item) => item !== except && item.owner === 'me' && item.sourceId === sourceId && item.name === name);
  const versionOf = (header: string | string[] | undefined): number | undefined => {
    const value = typeof header === 'string' ? /^"(\d+)"$/.exec(header)?.[1] : undefined;
    return value === undefined ? undefined : Number(value);
  };

  return {
    reset: (): void => {
      items = seed();
      next = 100;
    },
    list: (sourceId: string | null, response: ServerResponse): void => json(response, 200, { items: items.filter((item) => item.sourceId === sourceId && visible(item)).map(listedOf), nextCursor: null }),
    save: (body: unknown, response: ServerResponse): void => {
      const parsed = savePatternRequestSchema.safeParse(body);
      if (!parsed.success || parsed.data.kind !== 'definition') return refuse(response, 'INVALID_REQUEST');
      if (nameTaken(parsed.data.sourceId, parsed.data.name.trim(), undefined)) return refuseNameTaken(response);
      const item: Stored = { id: id(next++), sourceId: parsed.data.sourceId, name: parsed.data.name.trim(), definition: parsed.data.definition, anchor: parsed.data.anchor ?? null, visibility: 'private', version: 1, owner: 'me', unavailable: false, createdAt: AT };
      items = [item, ...items];
      json(response, 201, storedOf(item), { etag: '"1"' });
    },
    change: (given: string, body: unknown, response: ServerResponse): void => {
      const parsed = changePatternRequestSchema.safeParse(body);
      const item = find(given);
      if (!parsed.success) return refuse(response, 'INVALID_REQUEST');
      if (item === undefined) return refuse(response, 'NOT_FOUND');
      if (item.owner !== 'me') return refuse(response, 'ACCESS_DENIED');
      if (parsed.data.expectedVersion !== item.version) return refuse(response, 'CONFLICT');
      if (parsed.data.name !== undefined && nameTaken(item.sourceId, parsed.data.name.trim(), item)) return refuseNameTaken(response);
      if (parsed.data.name !== undefined) item.name = parsed.data.name.trim();
      if (parsed.data.definition !== undefined) item.definition = parsed.data.definition;
      if (parsed.data.anchor !== undefined) item.anchor = parsed.data.anchor;
      if (parsed.data.visibility !== undefined) item.visibility = parsed.data.visibility;
      item.version += 1;
      json(response, 200, storedOf(item), { etag: `"${item.version}"` });
    },
    remove: (given: string, header: string | string[] | undefined, response: ServerResponse): void => {
      const item = find(given);
      if (item === undefined) return refuse(response, 'NOT_FOUND');
      if (item.owner !== 'me') return refuse(response, 'ACCESS_DENIED');
      if (versionOf(header) !== item.version) return refuse(response, 'CONFLICT');
      items = items.filter((candidate) => candidate !== item);
      json(response, 200, { id: item.id, version: item.version + 1, deletedAt: AT, purgeAfter: '2026-12-12T10:00:00.000Z' });
    },
    copy: (given: string, response: ServerResponse): void => {
      const item = find(given);
      if (item === undefined) return refuse(response, 'NOT_FOUND');
      let copyName = `${item.name} (copy)`;
      for (let n = 2; nameTaken(item.sourceId, copyName, undefined); n += 1) copyName = `${item.name} (copy ${n})`;
      const copy: Stored = { ...item, name: copyName, id: id(next++), visibility: 'private', version: 1, owner: 'me' };
      items = [copy, ...items];
      json(response, 201, storedOf(copy), { etag: '"1"' });
    },
    run: async (given: string, body: unknown, response: ServerResponse, request: IncomingMessage): Promise<void> => {
      const item = find(given);
      if (item === undefined) return refuse(response, 'NOT_FOUND');
      if (item.unavailable) return json(response, 200, { status: 'unavailable', reasons: [{ code: 'unknown-entity-type', path: ['steps', 0, 'arrivesAt'] }] });
      const asked = typeof body === 'object' && body !== null ? body : {};
      const anchor = 'anchor' in asked && typeof asked.anchor === 'object' && asked.anchor !== null ? asked.anchor : item.anchor;
      if (anchor === null) return refuse(response, 'INVALID_REQUEST');
      return runPattern({ sourceId: item.sourceId, definition: item.definition, anchor, ...('continue' in asked && asked.continue === true ? { continue: true, limit: 'limit' in asked ? asked.limit : undefined } : {}), ...('cursor' in asked && typeof asked.cursor === 'string' ? { cursor: asked.cursor } : {}) }, response, request);
    },
  };
}
