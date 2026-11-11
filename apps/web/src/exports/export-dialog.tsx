import { EXPORT_SCOPE, type ExportFormat } from '@neburyx/contracts';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { DIALOG_BEHIND_ATTRIBUTE } from '../lifecycle/dialog-behind.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useNotRetrieved } from '../workspace/graph-scope.js';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { remainderLine } from '../workspace/scope-text.js';
import { CANCEL, EXPORT_BUSY, EXPORT_TITLE, FOOTNOTE, FORMAT_LABEL, FORMAT_NAMES, NETWORK_FAILURE, PREPARING, PREVIEW_HEADING, SCHEMA_FAILURE, TRY_AGAIN, downloadLabel, tooLargeText } from './copy.js';
import { exportRequestOf, keyAfter, newExportKey } from './export-attempt.js';
import { saveFile } from './save-file.js';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';
const FORMATS: readonly ExportFormat[] = ['json', 'csv'];

type Outcome = { readonly kind: 'none' } | { readonly kind: 'failed'; readonly failure: ApiFailure };

export function failureText(failure: ApiFailure): string {
  if (!('message' in failure)) return failure.code === 'SCHEMA_MISMATCH' ? SCHEMA_FAILURE : NETWORK_FAILURE;
  // a conflict with no reason is the same key still running; one with a reason (a changed source) has its own sentence
  if (failure.code === 'CONFLICT' && failure.details?.reason === undefined) return EXPORT_BUSY;
  const limit = failure.details?.maxElements;
  return failure.code === 'INVALID_REQUEST' && limit !== undefined ? tooLargeText(failure.message, limit) : failure.message;
}

/** Whether a failed download says the person's access changed since the export was made. */
export function isAccessChanged(failure: ApiFailure): boolean {
  return failure.code === 'ACCESS_DENIED' && 'details' in failure && failure.details?.reason === 'access-changed';
}

export interface ExportDialogProps {
  readonly client: ApiClient;
  readonly onClose: () => void;
  /** Called, after the dialog is closed, when the download is refused because access changed. */
  readonly onAccessChanged: () => void;
  /** Called when the file was handed to the browser. */
  readonly onDone?: () => void;
  readonly save?: typeof saveFile;
  readonly now?: () => Date;
}

/** "Export current view": the format, the lines every export starts with, and the file. */
export function ExportDialog({ client, onClose, onAccessChanged, onDone, save = saveFile, now = () => new Date() }: ExportDialogProps) {
  const state = useClientState();
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const notRetrieved = useNotRetrieved();
  const opened = useMemo(() => now().toISOString(), [now]);
  const shown = useMemo(() => state.visibleGraph().nodes.length, [state]);
  const sourceId = useStoreSelector(state.investigation, (held) => held.sourceId) ?? '';
  const [format, setFormat] = useState<ExportFormat>('json');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const key = useRef(newExportKey());
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const previewId = useId();
  const sendingNow = useRef(false);

  useEffect(() => {
    const behind = document.querySelectorAll(`[${KEY_SCOPE_ATTRIBUTE}="workspace"], [${DIALOG_BEHIND_ATTRIBUTE}]`);
    for (const element of behind) element.setAttribute('inert', '');
    dialog.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, []);

  const send = async (): Promise<void> => {
    if (sendingNow.current || investigationId === null) return;
    sendingNow.current = true;
    setSending(true);
    setOutcome({ kind: 'none' });
    const created = await client.createExport(investigationId, exportRequestOf(state.visibleGraph(), format), key.current);
    if (!created.ok) {
      key.current = keyAfter(created.failure, key.current);
      sendingNow.current = false;
      setSending(false);
      setOutcome({ kind: 'failed', failure: created.failure });
      return;
    }
    const downloaded = await client.downloadExport(created.value.id);
    sendingNow.current = false;
    setSending(false);
    if (downloaded.ok) {
      save(downloaded.value);
      onDone?.();
      onClose();
      return;
    }
    if (isAccessChanged(downloaded.failure)) {
      onClose();
      onAccessChanged();
      return;
    }
    key.current = newExportKey();
    setOutcome({ kind: 'failed', failure: downloaded.failure });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!sending) onClose();
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
  const lines = [`source: ${sourceId}`, `exported: ${opened}`, `scope: ${EXPORT_SCOPE}`, `coverage: ${remainderLine(shown, notRetrieved)}`, 'masking: off'];

  return createPortal(
    <div className="sheet-scrim export-scrim">
      <div ref={dialog} className="sheet export-dialog" role="dialog" aria-modal="true" aria-labelledby={headingId} aria-describedby={previewId} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="export-title">
          <h2 id={headingId} className="sheet-heading">
            {EXPORT_TITLE}
          </h2>
          <button type="button" className="sheet-close" aria-label="Close" onClick={onClose} disabled={sending}>
            <span aria-hidden="true">✕</span>
          </button>
        </div>
        <fieldset className="export-formats" disabled={sending}>
          <legend>{FORMAT_LABEL}</legend>
          {FORMATS.map((option) => (
            <label key={option} className="export-format">
              <input type="radio" name={`${headingId}-format`} value={option} checked={format === option} onChange={() => setFormat(option)} />
              {FORMAT_NAMES[option]}
            </label>
          ))}
        </fieldset>
        <div id={previewId} className="export-preview">
          <p className="export-preview-heading">{PREVIEW_HEADING}</p>
          <ul className="export-preview-lines">
            {lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <p className="export-footnote">{FOOTNOTE}</p>
        <p role="status" className="export-problem">
          {failure === undefined ? '' : failureText(failure)}
        </p>
        <div className="export-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={sending}>
            {CANCEL}
          </button>
          <button type="button" className="primary" disabled={sending || investigationId === null} aria-busy={sending} onClick={() => void send()}>
            {sending ? PREPARING : failure === undefined ? downloadLabel(format) : TRY_AGAIN}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
