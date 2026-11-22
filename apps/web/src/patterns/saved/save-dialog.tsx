import { useEffect, useId, useRef, useState } from 'react';
import { PATTERN_LIMITS, type ListedPattern, type PatternDefinition, type SavedPattern } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { Dialog } from '../../views/dialog.js';
import { pathSummary } from './path-summary.js';
import type { SummaryLine } from './preset-summary.js';
import { SAVED_COPY, isNameTaken, nameLimitText, refusalText } from './saved-copy.js';
import { nameFits } from './saved-model.js';
import type { Notice } from './use-row-actions.js';

export type SaveMode = { readonly kind: 'new' } | { readonly kind: 'change'; readonly item: ListedPattern };

type SaveSubject =
  | { readonly kind: 'definition'; readonly definition: PatternDefinition }
  | { readonly kind: 'preset'; readonly presetId: string; readonly presetName: string; readonly templateVersion: string; readonly params: Readonly<Record<string, unknown>>; readonly summary: readonly SummaryLine[]; readonly suggestedName: string; readonly startLabel: string };

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly subject: SaveSubject;
  /** The starting entity chosen on the preview, or nothing. */
  readonly anchor: { readonly entityType: string; readonly stableId: string } | undefined;
  readonly nameOf: (type: string) => string;
  readonly onClose: () => void;
  /** Called once when the pattern is saved (or saved and not shared); the dialog is closed by the caller. */
  readonly onDone: (notice: Notice, saved: SavedPattern) => void;
}

/** The name a new pattern is offered under: its path, cut to the limit of a name. */
const suggestedName = (definition: PatternDefinition, nameOf: (type: string) => string): string => Array.from(pathSummary(definition, nameOf)).slice(0, PATTERN_LIMITS.nameLength).join('');

const OPTIONS = [
  { value: 'private', title: SAVED_COPY.onlyMe, line: SAVED_COPY.onlyMeLine },
  { value: 'shared', title: SAVED_COPY.everyone, line: SAVED_COPY.everyoneLine },
] as const;

/**
 * The Save pattern dialog (PB16): the name with its rule, who can use it, Cancel and Save. A refusal keeps the dialog open with what the person typed; a pattern shared with everyone is saved first and then shared, so that a refused share
 * leaves it saved and private. Whether the pattern asks for its starting entity each time stays a choice under the two options (the frame has none; listed).
 */
export function SavePatternDialog({ client, sourceId, subject, anchor, nameOf, onClose, onDone }: Props) {
  const [name, setName] = useState(subject.kind === 'definition' ? suggestedName(subject.definition, nameOf) : Array.from(subject.suggestedName).slice(0, PATTERN_LIMITS.nameLength).join(''));
  const [ask, setAsk] = useState(true);
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [refusedName, setRefusedName] = useState<string | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const nameId = useId();
  const ruleId = useId();
  const forced = anchor === undefined;
  const asks = forced || ask;
  const fits = nameFits(name);
  const taken = refusedName !== undefined && refusedName === name.trim();
  const preset = subject.kind === 'preset' ? subject : undefined;
  useEffect(() => {
    abort.current = new AbortController();
    return () => abort.current?.abort();
  }, []);

  const submit = async (): Promise<void> => {
    if (!fits || busy || taken) return;
    const signal = abort.current?.signal;
    const aborted = (): boolean => signal?.aborted === true;
    setBusy(true);
    setMessage(undefined);
    const held = asks || anchor === undefined ? undefined : anchor;
    const body = subject.kind === 'definition' ? { sourceId, kind: 'definition' as const, name: name.trim(), definition: subject.definition } : { sourceId, kind: 'preset-run' as const, name: name.trim(), presetId: subject.presetId, params: subject.params };
    const saved = await client.savePattern({ ...body, ...(held === undefined ? {} : { anchor: held }) }, signal);
    if (aborted()) return;
    if (!saved.ok) {
      setBusy(false);
      if (saved.failure.code === 'ABORTED') return;
      if (isNameTaken(saved.failure)) setRefusedName(name.trim());
      setMessage(refusalText(saved.failure));
      return;
    }
    if (visibility === 'private') {
      setBusy(false);
      onDone({ text: SAVED_COPY.saved, tone: 'done' }, saved.value);
      return;
    }
    const shared = await client.changePattern(saved.value.id, { expectedVersion: saved.value.version, visibility: 'shared' }, signal);
    if (aborted()) return;
    setBusy(false);
    if (shared.ok) onDone({ text: SAVED_COPY.saved, tone: 'done' }, shared.value);
    else onDone({ text: `${SAVED_COPY.savedNotShared} ${shared.failure.code === 'ABORTED' ? '' : refusalText(shared.failure)}`.trim(), tone: 'problem' }, saved.value);
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
          <input id={nameId} type="text" className="patterns-input" value={name} aria-invalid={fits && !taken ? undefined : true} aria-describedby={preset !== undefined && fits && !taken ? undefined : ruleId} onChange={(event) => setName(event.target.value)} />
          {preset !== undefined && fits && !taken ? null : (
            <p id={ruleId} className="rename-hint">
              {SAVED_COPY.nameRule}
            </p>
          )}
          {fits ? null : (
            <p role="alert" className="rename-problem">
              {nameLimitText}
            </p>
          )}
          {preset === undefined ? null : (
            <>
              <div className="save-field">
                <span className="supernode-label">{SAVED_COPY.pattern}</span>
                <span className="save-pattern-line">
                  {preset.presetName}
                  <span className="save-pill">{`v${preset.templateVersion}`}</span>
                </span>
              </div>
              {preset.summary.length === 0 ? null : (
                <dl className="save-summary" aria-label={SAVED_COPY.parameters}>
                  <dt className="supernode-label save-summary-heading">{SAVED_COPY.parameters}</dt>
                  {preset.summary.map((line) => (
                    <div key={line.label} className="save-summary-row">
                      <dt>{line.label}</dt>
                      <dd>{line.text}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <label className="pattern-type">
                <input type="checkbox" checked={asks} disabled={forced} onChange={(event) => setAsk(event.target.checked)} />
                {SAVED_COPY.askEachTimeOf(preset.startLabel)}
              </label>
              {forced ? <p className="rename-hint">{SAVED_COPY.askEachTimeForcedOf(preset.startLabel)}</p> : null}
              <fieldset className="save-plain-options">
                <legend className="supernode-label">{SAVED_COPY.visibilityLegend}</legend>
                {OPTIONS.map((option) => (
                  <label key={option.value} className="pattern-type">
                    <input type="radio" name="pattern-visibility" value={option.value} checked={visibility === option.value} onChange={() => setVisibility(option.value)} />
                    {option.title}
                  </label>
                ))}
              </fieldset>
              <p className="rename-hint">{SAVED_COPY.saveText}</p>
            </>
          )}
          {preset !== undefined ? null : (
          <fieldset className="save-options">
            <legend className="supernode-label">{SAVED_COPY.visibility}</legend>
            {OPTIONS.map((option) => (
              <label key={option.value} className="save-option" data-checked={visibility === option.value}>
                <input type="radio" name="pattern-visibility" value={option.value} checked={visibility === option.value} aria-labelledby={`${nameId}-${option.value}`} aria-describedby={`${nameId}-${option.value}-line`} onChange={() => setVisibility(option.value)} />
                <span className="save-option-text">
                  <span id={`${nameId}-${option.value}`} className="save-option-title">
                    {option.title}
                  </span>
                  <span id={`${nameId}-${option.value}-line`} className="save-option-line">
                    {option.line}
                  </span>
                </span>
              </label>
            ))}
          </fieldset>
          )}
          {preset !== undefined ? null : (
            <label className="pattern-type">
              <input type="checkbox" checked={asks} disabled={forced} onChange={(event) => setAsk(event.target.checked)} />
              {SAVED_COPY.askEachTime}
            </label>
          )}
          {preset !== undefined || !forced ? null : <p className="rename-hint">{SAVED_COPY.askEachTimeForced}</p>}
          {message === undefined ? null : (
            <p role="alert" className="rename-problem">
              {message}
            </p>
          )}
          <div className="rename-actions">
            <button type="button" className="secondary" disabled={busy} onClick={onClose}>
              {SAVED_COPY.cancel}
            </button>
            <button type="submit" className="primary" disabled={!fits || busy || taken} aria-busy={busy ? true : undefined}>
              {busy ? SAVED_COPY.saving : subject.kind === 'preset' ? SAVED_COPY.saveDialog : SAVED_COPY.saveButton}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
