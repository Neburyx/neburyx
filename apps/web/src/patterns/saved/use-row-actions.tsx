import { useEffect, useId, useRef, useState } from 'react';
import type { ListedPattern } from '@neburyx/contracts';
import type { ApiClient, ApiFailure, ApiResult } from '../../api/client.js';
import { Dialog } from '../../views/dialog.js';
import { SAVED_COPY, deleteTitle, isNameTaken, nameLimitText, refusalText } from './saved-copy.js';
import { nameFits } from './saved-model.js';

export interface Notice {
  readonly text: string;
  readonly tone: 'done' | 'problem';
}

type DialogKind = 'rename' | 'delete' | 'share';

export interface RowActionState {
  readonly dialog: { readonly kind: DialogKind; readonly item: ListedPattern } | undefined;
  readonly busy: boolean;
  /** What the last refusal said, shown in the dialog that is open. */
  readonly message: string | undefined;
  /** The name the server refused as already used: the dialog keeps the name and waits for another. */
  readonly refusedName: string | undefined;
  /** The pattern the person deleted last, so that what shows it (a run) goes with it. */
  readonly removed: string | undefined;
  readonly open: (kind: DialogKind, item: ListedPattern) => void;
  readonly close: () => void;
  readonly rename: (item: ListedPattern, name: string) => void;
  readonly remove: (item: ListedPattern) => void;
  readonly share: (item: ListedPattern) => void;
  readonly unshare: (item: ListedPattern) => void;
  readonly copy: (item: ListedPattern) => void;
}

const REREAD: ReadonlySet<string> = new Set(['CONFLICT', 'NOT_FOUND', 'ACCESS_DENIED']);

/**
 * The actions of a row's menu. Each is one request with the version the list holds; what the server answers is shown in words, the list is read again after a change or a refusal that says it is out of date, and an answer that comes after the
 * panel has gone (a change of source) is dropped with its request aborted.
 */
export function useRowActions(client: ApiClient, reload: () => void, notify: (notice: Notice) => void): RowActionState {
  const [dialog, setDialog] = useState<RowActionState['dialog']>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [removed, setRemoved] = useState<string | undefined>(undefined);
  const [refusedName, setRefusedName] = useState<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const working = useRef(false);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);

  const perform = async <T,>(call: (signal: AbortSignal | undefined) => Promise<ApiResult<T>>, done: string, gone?: string, name?: string): Promise<void> => {
    if (working.current) return;
    working.current = true;
    const signal = abort.current?.signal;
    setBusy(true);
    setMessage(undefined);
    const result = await call(signal);
    working.current = false;
    if (signal?.aborted === true) return;
    setBusy(false);
    if (result.ok) {
      if (gone !== undefined) setRemoved(gone);
      setDialog(undefined);
      notify({ text: done, tone: 'done' });
      reload();
      return;
    }
    if (result.failure.code === 'ABORTED') return;
    refuse(result.failure, name);
  };
  const refuse = (failure: ApiFailure, name: string | undefined): void => {
    const text = refusalText(failure);
    setMessage(text);
    if (isNameTaken(failure)) {
      // the dialog stays open with the name kept, and the list is not read again
      setRefusedName(name?.trim());
      return;
    }
    if (REREAD.has(failure.code)) {
      setDialog(undefined);
      notify({ text, tone: 'problem' });
      reload();
      return;
    }
    notify({ text, tone: 'problem' });
  };

  return {
    dialog,
    busy,
    message,
    refusedName,
    removed,
    open: (kind, item) => {
      setMessage(undefined);
      setRefusedName(undefined);
      setDialog({ kind, item });
    },
    close: () => {
      if (!busy) setDialog(undefined);
    },
    rename: (item, name) => void perform((signal) => client.changePattern(item.id, { expectedVersion: item.version, name: name.trim() }, signal), SAVED_COPY.renamed, undefined, name),
    remove: (item) => void perform((signal) => client.deletePattern(item.id, item.version, signal), SAVED_COPY.deleted, item.id),
    share: (item) => void perform((signal) => client.changePattern(item.id, { expectedVersion: item.version, visibility: 'shared' }, signal), SAVED_COPY.sharedDone),
    unshare: (item) => void perform((signal) => client.changePattern(item.id, { expectedVersion: item.version, visibility: 'private' }, signal), SAVED_COPY.unsharedDone),
    copy: (item) => void perform((signal) => client.copyPattern(item.id, signal), SAVED_COPY.copied),
  };
}

/** The dialogs of the rename, the share and the delete: each asks once, holds the person's input on a refusal and sends nothing twice. */
export function RowDialogs({ actions }: { readonly actions: RowActionState }) {
  const { dialog } = actions;
  if (dialog === undefined) return null;
  if (dialog.kind === 'delete') {
    const shared = dialog.item.visibility === 'shared';
    return (
      <Dialog title={deleteTitle(dialog.item.name)} onClose={actions.busy ? undefined : actions.close} initialFocus="[data-initial-focus]">
        {() => (
          <div className="rename-form">
            <p>{shared ? SAVED_COPY.deleteConfirmShared : SAVED_COPY.deleteConfirmPrivate}</p>
            {actions.message === undefined ? null : (
              <p role="alert" className="rename-problem">
                {actions.message}
              </p>
            )}
            <div className="rename-actions">
              <button type="button" className="secondary" data-initial-focus disabled={actions.busy} onClick={actions.close}>
                {SAVED_COPY.cancel}
              </button>
              <button type="button" className="primary confirm-danger" disabled={actions.busy} aria-busy={actions.busy ? true : undefined} onClick={() => actions.remove(dialog.item)}>
                {actions.busy ? SAVED_COPY.working : shared ? SAVED_COPY.deleteEveryone : SAVED_COPY.deletePattern}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    );
  }
  if (dialog.kind === 'share') {
    return (
      <Dialog title={SAVED_COPY.shareTitle} onClose={actions.busy ? undefined : actions.close}>
        {() => (
          <div className="rename-form">
            <p>{dialog.item.name}</p>
            <p>{SAVED_COPY.shareConfirm}</p>
            {actions.message === undefined ? null : (
              <p role="alert" className="rename-problem">
                {actions.message}
              </p>
            )}
            <div className="rename-actions">
              <button type="button" className="secondary" onClick={actions.close}>
                {SAVED_COPY.cancel}
              </button>
              <button type="button" className="primary" disabled={actions.busy} aria-busy={actions.busy ? true : undefined} onClick={() => actions.share(dialog.item)}>
                {actions.busy ? SAVED_COPY.working : SAVED_COPY.share}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    );
  }
  return <RenameForm actions={actions} item={dialog.item} />;
}

function RenameForm({ actions, item }: { readonly actions: RowActionState; readonly item: ListedPattern }) {
  const [name, setName] = useState(item.name);
  const fieldId = useId();
  const ruleId = useId();
  const fits = nameFits(name);
  const taken = actions.refusedName !== undefined && actions.refusedName === name.trim();
  return (
    <Dialog title={SAVED_COPY.renameTitle} onClose={actions.busy ? undefined : actions.close} initialFocus="input">
      {() => (
        <form
          className="rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (fits && !taken && !actions.busy) actions.rename(item, name);
          }}
        >
          <label htmlFor={fieldId} className="supernode-label">
            {SAVED_COPY.name}
          </label>
          <input id={fieldId} className="patterns-input" value={name} aria-invalid={fits && !taken ? undefined : true} aria-describedby={ruleId} onChange={(event) => setName(event.target.value)} />
          <p id={ruleId} className="rename-hint">
            {SAVED_COPY.nameRule}
          </p>
          {fits ? null : (
            <p role="alert" className="rename-problem">
              {nameLimitText}
            </p>
          )}
          {actions.message === undefined ? null : (
            <p role="alert" className="rename-problem">
              {actions.message}
            </p>
          )}
          <div className="rename-actions">
            <button type="button" className="secondary" onClick={actions.close}>
              {SAVED_COPY.cancel}
            </button>
            <button type="submit" className="primary" disabled={!fits || taken || actions.busy} aria-busy={actions.busy ? true : undefined}>
              {actions.busy ? SAVED_COPY.working : SAVED_COPY.rename}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
