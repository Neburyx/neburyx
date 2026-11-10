import { investigationTitleSchema, MAX_TITLE_LENGTH } from '@neburyx/contracts';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { CANCEL, NAME_HINT, NAME_LABEL, RELOAD, RENAME, RENAME_DISABLED, RENAME_TITLE, RENAMING, TITLE_EMPTY, TITLE_INVALID, TITLE_TOO_LONG } from './copy.js';
import { refreshRecord } from './refresh-record.js';
import { isReadOnlyRefusal, messageOf } from './status-flow.js';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';

/** Why a title cannot be sent, in words, or `undefined` when it can. The test is the one the server applies. */
export function titleProblemOf(title: string): string | undefined {
  if (investigationTitleSchema.safeParse(title).success) return undefined;
  if (title.trim().length === 0) return TITLE_EMPTY;
  return Array.from(title).length > MAX_TITLE_LENGTH ? TITLE_TOO_LONG : TITLE_INVALID;
}

type Outcome = { readonly kind: 'none' } | { readonly kind: 'failed'; readonly failure: ApiFailure };

/** The "Rename investigation" dialog: one name, validated as the server does, with the server's own message when the change is refused. */
export function RenameDialog({ client, onClose }: { readonly client: ApiClient; readonly onClose: () => void }) {
  const state = useClientState();
  const record = useStoreSelector(state.investigation, (held) => held.record);
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const [title, setTitle] = useState(record?.title ?? '');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const headingId = useId();
  const hintId = useId();
  const problemId = useId();
  const problem = titleProblemOf(title);
  const changed = record !== null && title !== record.title;
  const canSend = problem === undefined && changed && !sending && record !== null && !record.readOnly;

  useEffect(() => {
    const behind = document.querySelector(`[${KEY_SCOPE_ATTRIBUTE}="workspace"]`);
    behind?.setAttribute('inert', '');
    input.current?.focus();
    input.current?.select();
    return () => behind?.removeAttribute('inert');
  }, []);

  const send = async (): Promise<void> => {
    if (!canSend || investigationId === null || record === null) return;
    setSending(true);
    setOutcome({ kind: 'none' });
    const result = await client.renameInvestigation(investigationId, title, record.version);
    setSending(false);
    if (result.ok) {
      const held = state.investigation.getState();
      if (held.id === investigationId && held.record !== null) state.describeInvestigation({ ...held.record, title: result.value.investigation.title, version: result.value.investigation.version });
      onClose();
      return;
    }
    if (isReadOnlyRefusal(result.failure)) void refreshRecord(client, state, investigationId);
    setOutcome({ kind: 'failed', failure: result.failure });
  };

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    void send();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const failure = outcome.kind === 'failed' ? outcome.failure : undefined;
  const readOnly = failure !== undefined && isReadOnlyRefusal(failure);
  const reload = failure !== undefined && failure.code === 'CONFLICT' && !readOnly;
  const failureText = failure === undefined ? undefined : readOnly ? RENAME_DISABLED : messageOf(failure);
  const shownProblem = changed || title.length === 0 ? problem : undefined;

  return createPortal(
    <div className="sheet-scrim rename-scrim">
      <div ref={dialog} className="sheet rename-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="rename-title">
          <h2 id={headingId} className="sheet-heading">
            {RENAME_TITLE}
          </h2>
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <form className="rename-form" onSubmit={onSubmit}>
          <label htmlFor={`${headingId}-name`}>{NAME_LABEL}</label>
          <input
            ref={input}
            id={`${headingId}-name`}
            type="text"
            value={title}
            aria-describedby={`${hintId}${shownProblem === undefined ? '' : ` ${problemId}`}`}
            aria-invalid={shownProblem === undefined ? undefined : true}
            onChange={(event) => {
              setTitle(event.target.value);
              setOutcome({ kind: 'none' });
            }}
          />
          <p id={hintId} className="rename-hint">
            {NAME_HINT}
          </p>
          {shownProblem === undefined ? null : (
            <p id={problemId} className="rename-problem">
              {shownProblem}
            </p>
          )}
          {failureText === undefined ? null : (
            <p role="alert" className="rename-problem">
              {failureText}
              {reload ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      if (investigationId !== null) void refreshRecord(client, state, investigationId).then((refreshed) => setOutcome(refreshed ? { kind: 'none' } : { kind: 'failed', failure: { code: 'NETWORK_UNAVAILABLE' } }));
                    }}
                  >
                    {RELOAD}
                  </button>
                </>
              ) : null}
            </p>
          )}
          <div className="rename-actions">
            <button type="button" className="secondary" onClick={onClose}>
              {CANCEL}
            </button>
            <button type="submit" className="primary" disabled={!canSend}>
              {sending ? RENAMING : RENAME}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
