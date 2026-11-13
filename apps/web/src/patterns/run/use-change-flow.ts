import { useEffect, useRef, useState } from 'react';
import type { ListedPattern, PatternDefinition, SavedPattern } from '@neburyx/contracts';
import type { ApiClient, ApiResult } from '../../api/client.js';
import { saveAsCopy, saveChanges } from '../saved/change-actions.js';
import { SAVED_COPY, isNameTaken, refusalText } from '../saved/saved-copy.js';
import type { Notice } from '../saved/use-row-actions.js';

export interface ChangeFlow {
  /** The dialog on screen, or nothing: its sentence when a save was refused. */
  readonly dialog: { readonly message: string | undefined; /** The version the person read is out of date: only Save as a copy is left. */ readonly stale: boolean } | undefined;
  readonly busy: boolean;
  /** Save changes…: a private pattern is saved at once; a shared one asks first. */
  readonly start: () => void;
  readonly everyone: () => void;
  readonly copy: () => void;
  readonly cancel: () => void;
}

interface Inputs {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly item: ListedPattern | undefined;
  readonly definition: PatternDefinition;
  readonly anchor: { readonly entityType: string; readonly stableId: string } | undefined;
  readonly onDone: (notice: Notice, item: ListedPattern, saved: SavedPattern) => void;
  /** The list is out of date: the pattern changed or went. */
  readonly onStale: () => void;
}

/** The change of a saved pattern from the run view: one request at a time, the edits kept after a refusal, an answer after leaving dropped. */
export function useChangeFlow({ client, sourceId, item, definition, anchor, onDone, onStale }: Inputs): ChangeFlow {
  const [dialog, setDialog] = useState<ChangeFlow['dialog']>(undefined);
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | undefined>(undefined);
  const working = useRef(false);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);

  const perform = async (target: ListedPattern, call: (signal: AbortSignal | undefined) => Promise<ApiResult<SavedPattern>>, done: string): Promise<void> => {
    if (working.current) return;
    working.current = true;
    const signal = abort.current?.signal;
    setBusy(true);
    const result = await call(signal);
    working.current = false;
    if (signal?.aborted === true) return;
    setBusy(false);
    if (result.ok) {
      setDialog(undefined);
      onDone({ text: done, tone: 'done' }, target, result.value);
      return;
    }
    if (result.failure.code === 'ABORTED') return;
    const stale = result.failure.code === 'CONFLICT' && !isNameTaken(result.failure);
    if (stale || result.failure.code === 'NOT_FOUND') onStale();
    setDialog({ message: stale ? SAVED_COPY.changedMeanwhile : refusalText(result.failure), stale });
  };

  const everyone = (): void => {
    if (item !== undefined) void perform(item, (signal) => saveChanges(client, item, definition, anchor, signal), SAVED_COPY.saved);
  };
  return {
    dialog,
    busy,
    start: () => {
      if (item === undefined) return;
      if (item.visibility === 'shared') setDialog({ message: undefined, stale: false });
      else everyone();
    },
    everyone,
    copy: () => {
      if (item !== undefined) void perform(item, (signal) => saveAsCopy(client, sourceId, item, definition, anchor, signal), SAVED_COPY.copySaved);
    },
    cancel: () => {
      if (!busy) setDialog(undefined);
    },
  };
}
