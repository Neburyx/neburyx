import type { ExportRow, ExportStore, ExportWithInvestigation, IdempotencyStart } from '../db/exports-repository.js';
import type { InvestigationRow } from '../db/investigations-repository.js';

const DAY_MS = 86_400_000;
const IDEMPOTENCY_MS = DAY_MS;
const ABANDONED_MS = 15 * 60_000;

interface KeyEntry {
  readonly userId: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly policyVersion: string;
  readonly createdAt: number;
  state: 'running' | 'done';
  statusCode?: number;
  response?: unknown;
}

export interface MemoryExports extends ExportStore {
  readonly rows: ExportRow[];
  readonly keys: KeyEntry[];
  /** The clock of the store, in milliseconds: it moves with the clock the store was given, and a test moves it further by setting it. */
  readonly clock: { now: number };
}

export function memoryExports(deps: { readonly investigations: readonly InvestigationRow[]; readonly isDeleted: (id: string) => boolean; readonly now?: () => number }): MemoryExports {
  const rows: ExportRow[] = [];
  const keys: KeyEntry[] = [];
  const started = Date.now();
  const base = (): number => deps.now?.() ?? started;
  let moved = 0;
  const clock = {
    get now(): number {
      return base() + moved;
    },
    set now(value: number) {
      moved = value - base();
    },
  };
  const replace = (id: string, change: Partial<ExportRow>): void => {
    const index = rows.findIndex((row) => row.id === id);
    const held = rows[index];
    if (held !== undefined) rows[index] = { ...held, ...change };
  };
  const live = (entry: KeyEntry): boolean => clock.now - entry.createdAt < IDEMPOTENCY_MS;
  return {
    rows,
    keys,
    clock,
    insertExport: (input) => {
      const row: ExportRow = {
        id: input.id,
        investigationId: input.investigationId,
        requestedBy: input.requestedBy,
        policyVersion: input.policyVersion,
        sourceIdentityHash: input.sourceIdentityHash,
        kind: 'view',
        format: input.format,
        masked: false,
        maskedFieldCount: 0,
        status: 'pending',
        filename: null,
        storageKey: null,
        sizeBytes: null,
        sha256: null,
        errorCode: null,
        createdAt: new Date(clock.now).toISOString(),
        expiresAt: new Date(clock.now + input.retentionDays * DAY_MS).toISOString(),
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    completeExport: (id, ready) => {
      replace(id, { status: 'ready', ...ready, errorCode: null });
      return Promise.resolve();
    },
    failExport: (id, errorCode) => {
      replace(id, { status: 'failed', storageKey: null, errorCode });
      return Promise.resolve();
    },
    readExport: (id, requestedBy) => {
      const row = rows.find((candidate) => candidate.id === id && candidate.requestedBy === requestedBy);
      if (row === undefined) return Promise.resolve(undefined);
      const investigation = deps.investigations.find((candidate) => candidate.id === row.investigationId);
      const answer: ExportWithInvestigation = {
        row,
        expiredNow: Date.parse(row.expiresAt) <= clock.now,
        investigation: investigation === undefined ? undefined : { ownerId: investigation.ownerId, sourceId: investigation.sourceId, deleted: deps.isDeleted(investigation.id) },
      };
      return Promise.resolve(answer);
    },
    expireExport: (id) => {
      const held = rows.find((row) => row.id === id);
      if (held?.status === 'ready' || held?.status === 'pending') replace(id, { status: 'expired', storageKey: null });
      return Promise.resolve();
    },
    listExpiredExports: () => Promise.resolve(rows.filter((row) => row.status === 'ready' && Date.parse(row.expiresAt) <= clock.now).map((row) => ({ id: row.id, storageKey: row.storageKey }))),
    listStalePendingExports: (olderThanMs) => Promise.resolve(rows.filter((row) => row.status === 'pending' && Date.parse(row.createdAt) <= clock.now - olderThanMs).map((row) => row.id)),
    listStorageKeys: () => Promise.resolve(rows.flatMap((row) => (row.storageKey === null ? [] : [row.storageKey]))),
    exportFileKeys: (investigationId) => Promise.resolve(rows.flatMap((row) => (row.investigationId === investigationId ? [row.id] : []))),
    startIdempotent: (call) => {
      const index = keys.findIndex((entry) => entry.userId === call.userId && entry.key === call.key);
      const held = keys[index];
      if (held !== undefined && !live(held)) keys.splice(index, 1);
      const abandoned = held?.state === 'running' && clock.now - held.createdAt >= ABANDONED_MS;
      if (abandoned && held !== undefined) keys.splice(keys.indexOf(held), 1);
      const current = held !== undefined && live(held) && !abandoned ? held : undefined;
      if (current === undefined) {
        keys.push({ userId: call.userId, key: call.key, fingerprint: call.fingerprint, policyVersion: call.policyVersion, createdAt: clock.now, state: 'running' });
        return Promise.resolve<IdempotencyStart>({ outcome: 'new' });
      }
      if (current.fingerprint !== call.fingerprint || current.state === 'running' || current.statusCode === undefined) return Promise.resolve<IdempotencyStart>({ outcome: 'conflict' });
      return Promise.resolve<IdempotencyStart>({ outcome: 'replay', statusCode: current.statusCode, response: current.response, policyVersion: current.policyVersion });
    },
    finishIdempotent: (userId, key, statusCode, response) => {
      const held = keys.find((entry) => entry.userId === userId && entry.key === key);
      if (held !== undefined) {
        held.state = 'done';
        held.statusCode = statusCode;
        held.response = response;
      }
      return Promise.resolve();
    },
    forgetIdempotent: (userId, key) => {
      const index = keys.findIndex((entry) => entry.userId === userId && entry.key === key);
      if (index >= 0) keys.splice(index, 1);
      return Promise.resolve();
    },
    deleteStaleIdempotent: () => {
      const before = keys.length;
      const kept = keys.filter(live);
      keys.splice(0, keys.length, ...kept);
      return Promise.resolve(before - kept.length);
    },
  };
}
