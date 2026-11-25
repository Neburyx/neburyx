import type { AssistantThreadResponse } from '@neburyx/contracts';
import type { AssistantSession, Turn } from './assistant-session.js';

/**
 * The live turns that stay when the count a read tells is `read`: a turn whose own count is the read's or higher is newer than the clearing (pending, or answered and waiting for its store, which the read does not list yet) and stays; a turn with a lower count began before it and goes.
 * A pending turn that has no count yet stays, marked unverified, until its response tells one. A settled turn with no count goes after a rise and stays on a first read, which cannot tell whether it is older.
 */
export function turnsAfterRead(turns: readonly Turn[], read: number, rise: boolean): { readonly kept: Turn[]; readonly dropped: Turn[] } {
  const kept: Turn[] = [];
  const dropped: Turn[] = [];
  for (const turn of turns) {
    if (turn.threadEpoch !== undefined) (turn.threadEpoch >= read ? kept : dropped).push(turn);
    else if (turn.outcome.kind === 'pending') kept.push(read > 0 || rise ? { ...turn, unverified: true } : turn);
    else (rise ? dropped : kept).push(turn);
  }
  return { kept, dropped };
}

export interface TakenRead {
  readonly show: boolean;
  /** The read replaces what the session shows of the stored turns. */
  readonly replaces: boolean;
  readonly thread: AssistantThreadResponse;
}

/**
 * Takes a read of the thread that came back for this session. A read with no count changes nothing about the live turns. A read with a count below the highest the session has heard is from before and is not shown. Otherwise the session learns the count; a first read, or a higher count than the last read's, prunes the live turns
 * of before (a pending one is ended and its question removed) and keeps those of after; a higher count also means the person's chat was cleared, or the investigation closed, since the last read, so the read replaces the stored turns shown.
 */
export function takeRead(session: AssistantSession, read: AssistantThreadResponse): TakenRead {
  const count = read.epoch;
  if (count === undefined) return { show: true, replaces: false, thread: read };
  const { known } = session;
  if (known.seen !== undefined && count < known.seen) return { show: false, replaces: false, thread: read };
  const previous = known.epoch;
  known.epoch = count;
  known.seen = count;
  if (previous !== undefined && count === previous) return { show: true, replaces: false, thread: read };
  const rise = previous !== undefined;
  const held = session.store.getState();
  const { kept, dropped } = turnsAfterRead(held.turns, count, rise);
  for (const turn of dropped) {
    session.requests.get(turn.id)?.abort();
    session.requests.delete(turn.id);
  }
  const marked = kept.filter((turn) => turn.unverified === true && held.turns.find((other) => other.id === turn.id)?.unverified !== true);
  if (dropped.length > 0 || marked.length > 0) session.store.setState({ ...held, turns: kept });
  const live = new Set(kept.flatMap((turn) => turn.turnIds ?? []));
  return { show: true, replaces: rise, thread: { ...read, turns: read.turns.filter((turn) => !live.has(turn.id)) } };
}

/**
 * Reads the thread again, for a window that is shown (visible or focused) with its panel open, or that heard a notice: a window that missed a clearing learns of it here. A read that shows no rise changes nothing on screen; one that shows a rise replaces the stored turns and removes the live turns of before.
 * A read that fails changes nothing.
 */
export async function rereadThread(session: AssistantSession, read: (signal: AbortSignal) => Promise<{ readonly ok: true; readonly value: AssistantThreadResponse } | { readonly ok: false }>): Promise<void> {
  const controller = new AbortController();
  const epoch = session.store.getState().epoch;
  session.open.add(controller);
  const result = await read(controller.signal);
  session.open.delete(controller);
  if (controller.signal.aborted || session.store.getState().epoch !== epoch || !result.ok) return;
  const taken = takeRead(session, result.value);
  if (taken.show && taken.replaces) session.stored.setState({ kind: 'ready', thread: taken.thread });
}

/**
 * Reads the thread again for a panel that comes back after the page of the chat was open in another window, and shows what the server holds: the turns made there are in it, which `rereadThread` does not show when no clearing has happened. The live turns of this window stay as they are and are not listed twice. A read that fails, or is from before a clearing this session has heard of, changes nothing. It says whether the read failed, so that a caller can try again when the window is shown, and how many turns the server held when the read was shown.
 */
export interface Reloaded {
  readonly failed: boolean;
  /** The turns the server holds, those not listed included; none when the read was not shown (it failed, it was dropped, or it is from before a clearing). */
  readonly held: number | undefined;
}

export async function reloadThread(session: AssistantSession, read: (signal: AbortSignal) => Promise<{ readonly ok: true; readonly value: AssistantThreadResponse } | { readonly ok: false }>): Promise<Reloaded> {
  const controller = new AbortController();
  const epoch = session.store.getState().epoch;
  session.open.add(controller);
  const result = await read(controller.signal);
  session.open.delete(controller);
  if (controller.signal.aborted || session.store.getState().epoch !== epoch) return { failed: false, held: undefined };
  if (!result.ok) return { failed: true, held: undefined };
  const taken = takeRead(session, result.value);
  if (!taken.show) return { failed: false, held: undefined };
  const live = new Set(session.store.getState().turns.flatMap((turn) => turn.turnIds ?? []));
  session.stored.setState({ kind: 'ready', thread: { ...taken.thread, turns: taken.thread.turns.filter((turn) => !live.has(turn.id)) } });
  return { failed: false, held: result.value.turns.length + result.value.earlierTurns };
}

