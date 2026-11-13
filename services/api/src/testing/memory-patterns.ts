import { PATTERN_LIMITS } from '@neburyx/contracts';
import type { ListedPatternRow, PatternChange, PatternCopy, PatternDeletion, NewPattern, PatternListPosition, PatternRow, PatternStore, PatternWriteContext } from '../db/patterns-repository.js';
import { uuidv7 } from '../identity/uuid.js';
import { AppError } from '../errors.js';
import { PATTERN_AUDIT_ACTIONS, type PatternEvent } from '../patterns/pattern-events.js';

export interface MemoryPatternOptions {
  /** A write of an event fails, as a failed insert does: the change is refused with `AUDIT_UNAVAILABLE`, nothing is kept and the seam is not called. */
  readonly failPatternEvent?: boolean;
}

export interface MemoryPatterns extends PatternStore {
  readonly patternRows: PatternRow[];
  /** When each deleted pattern was deleted and when it is purged. */
  readonly deletedPatterns: Map<string, { readonly deletedAt: string; readonly purgeAfter: string }>;
  readonly patternEvents: PatternEvent[];
}

/** The patterns of the memory store: the same answers, events and seam calls as the Postgres store, kept in memory. */
export function memoryPatterns(options: MemoryPatternOptions = {}): MemoryPatterns {
  const patternRows: PatternRow[] = [];
  const deleted = new Map<string, { readonly deletedAt: string; readonly purgeAfter: string }>();
  const live = (id: string, ownerId: string): PatternRow | undefined => (deleted.has(id) ? undefined : patternRows.find((row) => row.id === id && row.ownerId === ownerId));
  const replace = (row: PatternRow): void => void patternRows.splice(patternRows.findIndex((held) => held.id === row.id), 1, row);
  const patternEvents: PatternEvent[] = [];
  /** The latest display name of each person who wrote, as the database would show the current one. */
  const names = new Map<string, string>();
  const visible = (id: string, personId: string): PatternRow | undefined => (deleted.has(id) ? undefined : patternRows.find((row) => row.id === id && (row.ownerId === personId || row.visibility === 'shared')));
  // one second for each write, so that the order of changes is the order of the calls
  let writes = 0;
  let runs = 0;
  const stamp = (): string => new Date(Date.UTC(2026, 10, 12, 10, 0, 0) + writes++ * 1000).toISOString();
  const keyOf = (row: PatternRow): PatternListPosition => ({ updatedKey: row.updatedAt.replace('Z', '000Z'), id: row.id });

  /** The events of one change are written with its rows, and the seam is called after, as the transaction helper does. */
  async function commit(events: readonly PatternEvent[], context: PatternWriteContext, apply: () => void): Promise<void> {
    if (options.failPatternEvent === true) throw new AppError('AUDIT_UNAVAILABLE');
    names.set(context.principal.id, context.principal.displayName);
    apply();
    patternEvents.push(...events);
    let rejected = false;
    for (const event of events) {
      await context.audit
        .record({ actorId: context.principal.id, actorRole: context.principal.role, action: PATTERN_AUDIT_ACTIONS[event.action], result: 'success', sourceId: event.sourceId, resourceType: 'pattern', resourceRef: event.patternId, traceId: context.traceId })
        .catch(() => {
          rejected = true;
        });
    }
    if (rejected) throw new AppError('INTERNAL_ERROR');
  }

  return {
    patternRows,
    deletedPatterns: deleted,
    patternEvents,
    async savePattern(input: NewPattern, context) {
      const ownerId = context.principal.id;
      const held = patternRows.filter((row) => row.ownerId === ownerId && row.sourceId === input.sourceId && !deleted.has(row.id)).length;
      if (held >= PATTERN_LIMITS.patternsPerSource) return { outcome: 'limit' };
      const now = stamp();
      const row: PatternRow = {
        id: uuidv7(),
        ownerId,
        sourceId: input.sourceId,
        name: input.name,
        kind: input.kind,
        presetId: input.presetId,
        templateId: input.templateId,
        templateVersion: input.templateVersion,
        params: input.params,
        definition: input.definition,
        askForStartingEntity: input.anchor === null,
        anchorEntityType: input.anchor?.entityType ?? null,
        anchorStableId: input.anchor?.stableId ?? null,
        visibility: 'private',
        lastRunAt: null,
        createdAt: now,
        updatedAt: now,
        version: 1,
      };
      await commit([{ id: uuidv7(), sourceId: row.sourceId, patternId: row.id, actorId: ownerId, action: 'saved', version: 1 }], context, () => void patternRows.push(row));
      return { outcome: 'saved', row };
    },
    async purgeExpiredPatterns(beforeDelete) {
      const due = [...deleted].filter(([, when]) => Date.parse(when.purgeAfter) <= Date.now());
      for (const [id] of due) {
        const row = patternRows.find((held) => held.id === id);
        if (row === undefined) continue;
        await beforeDelete({ id, sourceId: row.sourceId });
        patternRows.splice(patternRows.indexOf(row), 1);
        deleted.delete(id);
      }
      return due.length;
    },
    readPattern: (id, ownerId) => Promise.resolve(live(id, ownerId)),
    readRunnablePattern: (id, principalId) => Promise.resolve(visible(id, principalId)),
    recordPatternRun(id, ownerId) {
      const held = live(id, ownerId);
      if (held === undefined) return Promise.resolve(false);
      replace({ ...held, lastRunAt: new Date(Date.UTC(2026, 10, 12, 12, 0, 0) + runs++ * 1000).toISOString() });
      return Promise.resolve(true);
    },
    async changePattern(change: PatternChange, context) {
      const held = live(change.id, change.ownerId);
      if (held === undefined) return { outcome: 'not-found' };
      if (held.version !== change.expectedVersion) return { outcome: 'conflict' };
      const row: PatternRow = {
        ...held,
        ...(change.name === undefined ? {} : { name: change.name }),
        ...(change.visibility === undefined ? {} : { visibility: change.visibility }),
        ...(change.definition === undefined ? {} : { definition: change.definition }),
        ...(change.params === undefined ? {} : { params: change.params }),
        ...(change.anchor === undefined ? {} : { anchorEntityType: change.anchor?.entityType ?? null, anchorStableId: change.anchor?.stableId ?? null, askForStartingEntity: change.anchor === null }),
        updatedAt: stamp(),
        version: held.version + 1,
      };
      await commit([{ id: uuidv7(), sourceId: row.sourceId, patternId: row.id, actorId: change.ownerId, action: change.action ?? 'changed', version: row.version }], context, () => replace(row));
      return { outcome: 'changed', row };
    },
    async deletePattern(deletion: PatternDeletion, context) {
      const held = live(deletion.id, deletion.ownerId);
      if (held === undefined) return { outcome: 'not-found' };
      if (held.version !== deletion.expectedVersion) return { outcome: 'conflict' };
      const at = stamp();
      const row: PatternRow = { ...held, updatedAt: at, version: held.version + 1 };
      const purgeAfter = new Date(Date.parse(at) + deletion.retentionDays * 86_400_000).toISOString();
      await commit([{ id: uuidv7(), sourceId: row.sourceId, patternId: row.id, actorId: deletion.ownerId, action: 'deleted', version: row.version }], context, () => {
        replace(row);
        deleted.set(row.id, { deletedAt: at, purgeAfter });
      });
      return { outcome: 'deleted', row, deletedAt: at, purgeAfter };
    },
    listPatterns(query) {
      const shown = (row: PatternRow): ListedPatternRow => ({ ...row, ownerName: names.get(row.ownerId) ?? '' });
      const ordered = patternRows
        .filter((row) => row.sourceId === query.sourceId && !deleted.has(row.id) && (row.ownerId === query.ownerId || row.visibility === 'shared'))
        .sort((a, b) => (keyOf(a).updatedKey === keyOf(b).updatedKey ? (a.id < b.id ? 1 : -1) : keyOf(a).updatedKey < keyOf(b).updatedKey ? 1 : -1))
        .filter((row) => query.after === undefined || keyOf(row).updatedKey < query.after.updatedKey || (keyOf(row).updatedKey === query.after.updatedKey && row.id < query.after.id));
      const page = ordered.slice(0, query.limit);
      const last = page.at(-1);
      return Promise.resolve({ rows: page.map(shown), next: ordered.length > query.limit && last !== undefined ? keyOf(last) : undefined });
    },
    async copyPattern(copy: PatternCopy, context) {
      const callerId = context.principal.id;
      const original = visible(copy.originalId, callerId);
      if (original === undefined) return { outcome: 'not-found' };
      if (!copy.accept(original)) return { outcome: 'refused' };
      const held = patternRows.filter((row) => row.ownerId === callerId && row.sourceId === original.sourceId && !deleted.has(row.id)).length;
      if (held >= PATTERN_LIMITS.patternsPerSource) return { outcome: 'limit' };
      const now = stamp();
      const row: PatternRow = { ...original, id: uuidv7(), ownerId: callerId, name: copy.nameOf(original.name), visibility: 'private', lastRunAt: null, createdAt: now, updatedAt: now, version: 1 };
      await commit(
        [
          { id: uuidv7(), sourceId: row.sourceId, patternId: row.id, actorId: callerId, action: 'copied', version: 1 },
          { id: uuidv7(), sourceId: original.sourceId, patternId: original.id, actorId: callerId, action: 'copied', version: original.version },
        ],
        context,
        () => void patternRows.push(row),
      );
      return { outcome: 'copied', row, original };
    },
  };
}
