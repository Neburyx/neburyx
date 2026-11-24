import { randomUUID } from 'node:crypto';
import { ExtensionRefusal, assistantThreadTurnWriteSchema, type AssistantThreadResponse, type AssistantThreadTurnWrite, type ExtensionLogger, type ExtensionRequest, type RecordQueue } from '@neburyx/contracts';
import { presentThread } from './thread-present.js';
import { AssistantThreadStoreError, type AssistantContextTurn, type AssistantThreadStore } from './thread-store.js';

export interface TurnThreadDeps {
  readonly threads: () => AssistantThreadStore | undefined;
  readonly queue: () => RecordQueue | undefined;
  readonly now: () => number;
  readonly logger: () => ExtensionLogger | undefined;
}

/** What a turn leaves of itself in its thread, before the schema has seen it: references and metadata, never text. */
type TurnThreadInput = Omit<AssistantThreadTurnWrite, 'id' | 'investigationId' | 'userId' | 'at'>;

export interface TurnThread {
  /** The id of the turn's row, made when the turn started, so a write that is tried again is one write. */
  readonly turnId: string;
  /** Builds the write through the strict schema and hands it to the queue of the records; it never waits and never throws. */
  write(input: TurnThreadInput): void;
  /** A write that was refused before it was built (a binding the classifier could not have approved): nothing is stored, and the failure is counted as a failed record write. */
  refused(step: string): void;
  /** The person's last `limit` turns of the thread as the router's context; a thread that cannot be read is counted as a failed record and gives none, so the turn goes on without it. */
  context(limit: number): Promise<readonly AssistantContextTurn[]>;
  /** The person's last `limit` turns of the thread as a read of it presents them for this mask and sensitivity version, for the loop's text context; a thread that cannot be read is counted as a failed record and gives none. */
  text(limit: number, maskNow: boolean, sensitivityVersion: string | undefined): Promise<AssistantThreadResponse | undefined>;
}

/**
 * The thread side of a turn. The investigation's epoch is read first, before the turn does any other work, and the write at the end is refused by the database when the epoch has moved, so a turn that began before a close cannot write after it.
 * A turn whose epoch cannot be read writes nothing; the failure is counted as a failed record write, and the turn is answered as before.
 */
export async function openTurnThread(deps: TurnThreadDeps, request: ExtensionRequest, started: { readonly investigationId: string; readonly turnId?: string }): Promise<TurnThread | undefined> {
  const store = deps.threads();
  if (store === undefined) return undefined;
  const turnId = started.turnId ?? randomUUID();
  // an id the panel chose that another person's thread or another investigation already holds is refused before the turn does anything: it would otherwise be written as a turn that is already stored
  if (started.turnId !== undefined) {
    let taken = false;
    try {
      taken = await store.turnIdTaken(started.turnId, started.investigationId, request.principalId);
    } catch {
      taken = false;
    }
    if (taken) throw new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'turn-id' });
  }
  const startedAt = deps.now();

  const failed = (step: string): void => {
    const queue = deps.queue();
    if (queue !== undefined) {
      queue.enqueue({ ids: { turnId, step }, write: () => Promise.reject(new AssistantThreadStoreError()) });
      return;
    }
    try {
      deps.logger()?.warn({ event: 'assistant-thread.not-recorded', turnId, step }, 'the thread of an assistant turn could not be recorded');
    } catch {
      // a logger that fails changes nothing
    }
  };

  let epoch: number | undefined;
  try {
    epoch = await store.epoch(started.investigationId);
  } catch {
    failed('epoch');
  }
  return {
    turnId,
    refused: (step) => failed(step),
    async context(limit) {
      try {
        return await store.readContext(started.investigationId, request.principalId, limit);
      } catch {
        failed('context');
        return [];
      }
    },
    async text(limit, maskNow, sensitivityVersion) {
      try {
        return presentThread(await store.read(started.investigationId, request.principalId, limit), maskNow, sensitivityVersion);
      } catch {
        failed('context-text');
        return undefined;
      }
    },
    write(input) {
      if (epoch === undefined) return;
      const known = epoch;
      let turn: AssistantThreadTurnWrite;
      try {
        turn = assistantThreadTurnWriteSchema.parse({ ...input, id: turnId, investigationId: started.investigationId, userId: request.principalId, at: new Date(startedAt) });
      } catch {
        failed('build');
        return;
      }
      const write = async (): Promise<void> => void (await store.append(turn, known));
      const queue = deps.queue();
      if (queue !== undefined) {
        queue.enqueue({ ids: { turnId, step: 'append' }, write });
        return;
      }
      try {
        write().catch(() => failed('append'));
      } catch {
        failed('append');
      }
    },
  };
}
