import { useEffect, useId, useRef, useState } from 'react';
import { PATTERN_LIMITS, type ListedPattern, type PatternDefinition } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { Dialog } from '../../views/dialog.js';
import { pathSummary } from './path-summary.js';
import { SAVED_COPY, nameLimitText, refusalText } from './saved-copy.js';
import { anchorChange, needsEntity, nameFits } from './saved-model.js';
import type { Notice } from './use-row-actions.js';

export type SaveMode = { readonly kind: 'new' } | { readonly kind: 'change'; readonly item: ListedPattern };

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly mode: SaveMode;
  readonly definition: PatternDefinition;
  /** The starting entity chosen in the run section, or nothing. */
  readonly anchor: { readonly entityType: string; readonly stableId: string } | undefined;
  readonly nameOf: (type: string) => string;
  readonly onClose: () => void;
  /** Called once when the pattern is saved (or saved and not shared); the dialog is closed by the caller. */
  readonly onDone: (notice: Notice, kept: { readonly saved: true }) => void;
}

/** The name a new pattern is offered under: its path, cut to the limit of a name. */
const suggestedName = (definition: PatternDefinition, nameOf: (type: string) => string): string => Array.from(pathSummary(definition, nameOf)).slice(0, PATTERN_LIMITS.nameLength).join('');

/**
 * The Save pattern dialog (frame 26, adapted): the name, a line about what is stored, the path, whether the pattern asks for its starting entity each time, and, for a new pattern, who may see it. A refusal keeps the dialog open with what the
 * person typed; a pattern shared with everyone is saved first and then shared, so that a refused share leaves it saved and private.
 */
export function SavePatternDialog({ client, sourceId, mode, definition, anchor, nameOf, onClose, onDone }: Props) {
  const [name, setName] = useState(mode.kind === 'change' ? mode.item.name : suggestedName(definition, nameOf));
  const [ask, setAsk] = useState(mode.kind === 'change' ? mode.item.askForStartingEntity : true);
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const nameId = useId();
  const forced = anchor === undefined && (mode.kind === 'new' || needsEntity(mode.item, definition));
  const asks = forced || ask;
  const fits = nameFits(name);
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);

  const submit = async (): Promise<void> => {
    if (!fits || busy) return;
    const signal = abort.current?.signal;
    const aborted = (): boolean => signal?.aborted === true;
    setBusy(true);
    setMessage(undefined);
    const held = asks || anchor === undefined ? undefined : anchor;
    if (mode.kind === 'change') {
      const moved = anchorChange(mode.item, definition, asks, anchor);
      const changed = await client.changePattern(mode.item.id, { expectedVersion: mode.item.version, name: name.trim(), definition, ...(moved.send ? { anchor: moved.anchor } : {}) }, signal);
      if (aborted()) return;
      setBusy(false);
      if (!changed.ok) {
        if (changed.failure.code !== 'ABORTED') setMessage(refusalText(changed.failure));
        return;
      }
      onDone({ text: SAVED_COPY.saved, tone: 'done' }, { saved: true });
      return;
    }
    const saved = await client.savePattern({ sourceId, kind: 'definition', name: name.trim(), definition, ...(held === undefined ? {} : { anchor: held }) }, signal);
    if (aborted()) return;
    if (!saved.ok) {
      setBusy(false);
      if (saved.failure.code !== 'ABORTED') setMessage(refusalText(saved.failure));
      return;
    }
    if (visibility === 'private') {
      setBusy(false);
      onDone({ text: SAVED_COPY.saved, tone: 'done' }, { saved: true });
      return;
    }
    const shared = await client.changePattern(saved.value.id, { expectedVersion: saved.value.version, visibility: 'shared' }, signal);
    if (aborted()) return;
    setBusy(false);
    onDone(shared.ok ? { text: SAVED_COPY.saved, tone: 'done' } : { text: `${SAVED_COPY.savedNotShared} ${shared.failure.code === 'ABORTED' ? '' : refusalText(shared.failure)}`.trim(), tone: 'problem' }, { saved: true });
  };

  return (
    <Dialog title={SAVED_COPY.saveDialog} onClose={busy ? undefined : onClose} initialFocus="input[type='text']">
      {() => (
        <form
          className="rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label htmlFor={nameId} className="supernode-label">
            {SAVED_COPY.name}
          </label>
          <input id={nameId} type="text" className="patterns-input" value={name} aria-invalid={fits ? undefined : true} onChange={(event) => setName(event.target.value)} />
          {fits ? null : (
            <p role="alert" className="rename-problem">
              {nameLimitText}
            </p>
          )}
          <p className="search-panel-note">{SAVED_COPY.saveText}</p>
          <p className="search-panel-note" aria-label={SAVED_COPY.summary}>
            {pathSummary(definition, nameOf)}
          </p>
          <label className="pattern-type">
            <input type="checkbox" checked={asks} disabled={forced} onChange={(event) => setAsk(event.target.checked)} />
            {SAVED_COPY.askEachTime}
          </label>
          {forced ? <p className="search-panel-note">{SAVED_COPY.askEachTimeForced}</p> : null}
          {mode.kind === 'change' && !asks && !needsEntity(mode.item, definition) ? <p className="search-panel-note">{SAVED_COPY.keepsEntity}</p> : null}
          {mode.kind === 'new' ? (
            <fieldset className="patterns-field">
              <legend className="supernode-label">{SAVED_COPY.visibility}</legend>
              {(['private', 'shared'] as const).map((value) => (
                <label key={value} className="pattern-type">
                  <input type="radio" name="pattern-visibility" value={value} checked={visibility === value} onChange={() => setVisibility(value)} />
                  {value === 'private' ? SAVED_COPY.onlyMe : SAVED_COPY.everyone}
                </label>
              ))}
            </fieldset>
          ) : null}
          {message === undefined ? null : (
            <p role="alert" className="rename-problem">
              {message}
            </p>
          )}
          <div className="rename-actions">
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>
              {SAVED_COPY.cancel}
            </button>
            <button type="submit" className="primary" disabled={!fits || busy} aria-busy={busy ? true : undefined}>
              {busy ? SAVED_COPY.saving : mode.kind === 'change' ? SAVED_COPY.saveChanges : SAVED_COPY.saveButton}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
