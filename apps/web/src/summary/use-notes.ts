import { useCallback, useEffect, useRef, useState } from 'react';
import type { AiNotesResponse } from '@neburyx/contracts';
import { useApiClient } from '../api/client-context.js';
import type { ApiFailure } from '../api/client.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { usePrincipalIdWhenProvided } from '../shell/shell-data.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { boundedRead } from '../api/read-wait.js';

export type NotesStage =
  | { readonly kind: 'closed' }
  | { readonly kind: 'loading'; readonly entries: AiNotesResponse | undefined }
  | { readonly kind: 'ready'; readonly entries: AiNotesResponse }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly entries: AiNotesResponse | undefined }
  | { readonly kind: 'refused' };

const REFUSED_CODES: ReadonlySet<string> = new Set(['ACCESS_DENIED', 'NOT_FOUND', 'CONFLICT', 'SOURCE_UNAVAILABLE', 'ASK_UNSUPPORTED']);

export interface NotesModel {
  /** What is shown: `closed` whenever what was read belongs to another context than the present one, so nothing incompatible is ever drawn. */
  readonly stage: NotesStage;
  readonly open: boolean;
  toggle(open: boolean): void;
  reload(): void;
}

/**
 * The AI notes saved with the view on screen, read when the section opens and again after a copy. What is shown belongs to one investigation, one masking, one person, one state of the source and one view the draft is based
 * on and one taking over of the draft (a restored view, even the same one again, brings its own notes): a change of any of them hides it at once, clears it and reads again, a late answer for an earlier one is never shown, and a refusal clears it; only a failure of the network or
 * the source keeps what is shown, and only within the same context.
 */
export function useNotes(copies: number, request: number): NotesModel {
  const client = useApiClient();
  const state = useClientState();
  const mask = useSessionMask();
  const principal = usePrincipalIdWhenProvided();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceState = useStoreSelector(state.investigation, (investigation) => investigation.record?.sourceState ?? 'available');
  const basedOn = investigationId === null ? null : (draftSyncOf(state, client).stateOf(investigationId)?.basedOnViewId ?? null);
  const adoptions = investigationId === null ? 0 : draftSyncOf(state, client).adoptionsOf(investigationId);
  const context = JSON.stringify([investigationId, mask, principal, sourceState, basedOn, adoptions]);
  const [open, setOpen] = useState(request > 0);
  const [held, setHeld] = useState<{ readonly stage: NotesStage; readonly context: string }>({ stage: { kind: 'closed' }, context });
  const controller = useRef<AbortController | undefined>(undefined);
  const kept = useRef<{ readonly entries: AiNotesResponse; readonly context: string } | undefined>(undefined);

  const read = useCallback(
    (keep: boolean): void => {
      controller.current?.abort();
      if (investigationId === null) return;
      const own = new AbortController();
      controller.current = own;
      const earlier = keep && kept.current?.context === context ? kept.current.entries : undefined;
      setHeld({ stage: { kind: 'loading', entries: earlier }, context });
      // the server reads the cited elements under its own deadline of 10 s
      void boundedRead((signal) => client.readAiNotes(investigationId, mask, signal), own.signal).then((result) => {
        if (own.signal.aborted) return;
        if (result.ok) {
          kept.current = { entries: result.value, context };
          setHeld({ stage: { kind: 'ready', entries: result.value }, context });
        } else if (REFUSED_CODES.has(result.failure.code)) {
          kept.current = undefined;
          setHeld({ stage: { kind: 'refused' }, context });
        } else {
          kept.current = undefined;
          setHeld({ stage: { kind: 'failed', failure: result.failure, entries: undefined }, context });
        }
      });
    },
    [client, context, investigationId, mask],
  );

  const known = useRef(context);
  const asked = useRef(request);
  useEffect(() => {
    if (request > 0) read(false);
    // reads once when the panel opens on the notes; later reads follow the section and the context
  }, []);
  useEffect(() => {
    if (asked.current === request) return;
    asked.current = request;
    setOpen(true);
    read(false);
  }, [request, read]);
  useEffect(() => {
    if (known.current === context) return;
    known.current = context;
    controller.current?.abort();
    kept.current = undefined;
    if (open) read(false);
  }, [context, open, read]);

  const lastCopies = useRef(copies);
  useEffect(() => {
    if (lastCopies.current === copies) return;
    lastCopies.current = copies;
    if (open) read(true);
  }, [copies, open, read]);

  useEffect(() => () => controller.current?.abort(), []);

  return {
    stage: held.context === context ? held.stage : { kind: 'closed' },
    open,
    toggle: (next) => {
      setOpen(next);
      if (next) read(false);
      else {
        controller.current?.abort();
        setHeld({ stage: { kind: 'closed' }, context });
      }
    },
    reload: () => read(true),
  };
}
