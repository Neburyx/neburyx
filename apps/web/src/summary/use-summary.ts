import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiClient } from '../api/client-context.js';
import { isSourceChanged } from '../state/investigation-state.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { heldKeysOf } from '../api/merge-into-loaded.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { citationEntries, pressOf, settledOf, summaryRequestOf, type CitationEntry } from './summary-model.js';
import { loadedLine } from '../workspace/scope-text.js';
import { SUMMARY_COPY } from './copy.js';
import { EMPTY_SUMMARY_SESSION, useSummarySession, type SummarySessionState } from './summary-session.js';

type FocusTarget = 'title' | 'start' | 'draft' | 'cancel';

export interface SummaryModel {
  readonly state: SummarySessionState;
  readonly sourceId: string | null;
  readonly investigationTitle: string;
  readonly sourceChanged: boolean;
  readonly focus: { readonly target: FocusTarget | undefined; readonly tick: number };
  readonly note: string;
  /** Starts a draft when the panel holds none and none is being made; a draft cleared by a change of investigation or masking waits for the person to ask. */
  begin(): void;
  generate(): void;
  cancel(): void;
  discard(): void;
  /** Escape: the first one cancels a draft that is being made, else it closes. */
  escape(): void;
  edit(index: number, text: string): void;
  press(entry: CitationEntry): void;
  close(): void;
}

const newKey = (): string => crypto.randomUUID();

/** The summary panel's whole behaviour: what it asks for, what it shows and the calls behind its buttons. The state is kept outside the panel, so closing it keeps the draft. */
export function useSummary(onClose: () => void): SummaryModel {
  const client = useApiClient();
  const state = useClientState();
  const session = useSummarySession();
  const view = useStoreSelector(session, (held) => held);
  const mask = useSessionMask();
  const investigationId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const sourceId = useStoreSelector(state.investigation, (investigation) => investigation.sourceId);
  const investigationTitle = useStoreSelector(state.investigation, (investigation) => investigation.record?.title ?? '');
  const sourceChanged = useStoreSelector(state.investigation, (investigation) => isSourceChanged(investigation.record?.sourceState));
  const controller = useRef<AbortController | undefined>(undefined);
  const [focus, setFocusState] = useState<{ readonly target: FocusTarget | undefined; readonly tick: number }>({ target: undefined, tick: 0 });
  const [note, setNote] = useState('');
  const setFocus = useCallback((target: FocusTarget): void => setFocusState((held) => ({ target, tick: held.tick + 1 })), []);
  const patch = useCallback((next: Partial<SummarySessionState>): void => session.setState({ ...session.getState(), ...next }), [session]);

  // a draft that is being made ends with the panel, and nothing of a late answer is shown
  useEffect(
    () => () => {
      controller.current?.abort();
      controller.current = undefined;
      if (session.getState().attempt.kind === 'generating') session.setState({ ...session.getState(), attempt: { kind: 'idle' } });
    },
    [session],
  );

  // another investigation or another masking clears the draft: what it showed was read for the earlier one
  useEffect(() => {
    const held = session.getState();
    if (held.investigationId === investigationId && held.mask === mask) return;
    controller.current?.abort();
    controller.current = undefined;
    const reason = held.investigationId !== investigationId ? 'investigation' : 'masking';
    const hadSomething = held.draft !== undefined || held.attempt.kind !== 'idle';
    session.setState({ ...EMPTY_SUMMARY_SESSION, investigationId, mask, attempt: hadSomething && held.investigationId !== null ? { kind: 'outcome', outcome: { kind: 'cleared', reason } } : { kind: 'idle' } });
    if (hadSomething) setFocus('title');
  }, [investigationId, mask, session, setFocus]);

  const generate = useCallback((): void => {
    const held = session.getState();
    if (held.attempt.kind === 'generating' || investigationId === null || sourceId === null) return;
    if (sourceChanged) {
      patch({ attempt: { kind: 'outcome', outcome: { kind: 'source-changed' } } });
      setFocus('title');
      return;
    }
    controller.current?.abort();
    const open = new AbortController();
    controller.current = open;
    setNote('');
    patch({ attempt: { kind: 'generating' } });
    setFocus('cancel');
    const request = summaryRequestOf(state.visibleGraph(), investigationId, sourceId, mask);
    void client.summarize(request, newKey(), open.signal).then((result) => {
      if (open.signal.aborted) return;
      controller.current = undefined;
      const settled = settledOf(result);
      if ('draft' in settled) {
        session.setState({ ...session.getState(), draft: { response: settled.draft, entries: citationEntries(settled.draft, state.loadedGraph()), edits: new Map(), viewLine: loadedLine(state.visibleGraph()) }, attempt: { kind: 'idle' } });
        setFocus('draft');
        return;
      }
      patch({ attempt: { kind: 'outcome', outcome: settled.outcome } });
      setFocus('title');
    });
  }, [client, investigationId, mask, patch, session, setFocus, sourceChanged, sourceId, state]);

  const cancel = useCallback((): void => {
    const open = controller.current;
    controller.current = undefined;
    open?.abort();
    if (session.getState().attempt.kind === 'generating') {
      patch({ attempt: { kind: 'idle' } });
      setFocus(session.getState().draft === undefined ? 'start' : 'draft');
    }
  }, [patch, session, setFocus]);

  return {
    state: view,
    sourceId,
    investigationTitle,
    sourceChanged,
    focus,
    note,
    begin: () => {
      const held = session.getState();
      const cleared = held.attempt.kind === 'outcome' && held.attempt.outcome.kind === 'cleared';
      if (held.draft === undefined && held.attempt.kind !== 'generating' && !cleared) generate();
    },
    generate,
    cancel,
    discard: () => {
      controller.current?.abort();
      controller.current = undefined;
      patch({ draft: undefined, attempt: { kind: 'idle' } });
      setNote('');
      setFocus('start');
    },
    escape: () => (session.getState().attempt.kind === 'generating' ? cancel() : onClose()),
    edit: (index, text) => {
      const held = session.getState().draft;
      if (held === undefined) return;
      patch({ draft: { ...held, edits: new Map(held.edits).set(index, text) } });
    },
    press: (entry) => {
      const outcome = pressOf(entry, drawnKeys(state.visibleGraph()), new Set([...heldKeysOf(state).nodes, ...heldKeysOf(state).edges]), SUMMARY_COPY);
      if (outcome.kind === 'note') {
        setNote(outcome.text);
        return;
      }
      setNote('');
      state.presentation.select([entry.graphKey]);
    },
    close: onClose,
  };
}

