import { EXPORT_SCOPE, exportedTimeLine } from '@neburyx/contracts';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ApiClient, ApiFailure } from '../api/client.js';
import type { PictureCapture } from '../canvas/masked-picture.js';
import { DIALOG_BEHIND_ATTRIBUTE } from '../lifecycle/dialog-behind.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { isLockedByPolicy, sensitiveFieldCount, sensitiveFieldNames } from '../mask/mask-view.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useNotRetrieved } from '../workspace/graph-scope.js';
import { KEY_SCOPE_ATTRIBUTE } from '../workspace/key-binding-handler.js';
import { remainderLine } from '../workspace/scope-text.js';
import { useCanvasCommands } from '../canvas/canvas-commands.js';
import { CANCEL, EXPORT_BUSY, FILE_MASKED_LINE, INCLUDE_SUMMARY, SUMMARY_REFUSED, EXPORT_TITLE, FOOTNOTE, FORMAT_LABEL, FORMAT_NAMES, NETWORK_FAILURE, PICTURE_FAILURE, PICTURE_MASKED_LINE, PREPARING, PREVIEW_HEADING, SCHEMA_FAILURE, TRY_AGAIN, downloadLabel, tooLargeText, type PictureFormat } from './copy.js';
import { exportRequestOf, keyAfter, newExportKey } from './export-attempt.js';
import { MaskButton, type MaskLock } from './mask-button.js';
import { useSummaryOption } from './summary-option.js';
import { composePicture, drawingBoundsFor } from './picture.js';
import { readMaskedView } from './masked-read.js';
import { saveFile } from './save-file.js';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])';
const FORMATS: readonly PictureFormat[] = ['json', 'csv', 'png'];

type Outcome = { readonly kind: 'none' } | { readonly kind: 'summary-refused' } | { readonly kind: 'failed'; readonly failure: ApiFailure } | { readonly kind: 'picture-failed' };

function failureText(failure: ApiFailure): string {
  if (!('message' in failure)) return failure.code === 'SCHEMA_MISMATCH' ? SCHEMA_FAILURE : NETWORK_FAILURE;
  // a conflict with no reason is the same key still running; one with a reason (a changed source) has its own sentence
  if (failure.code === 'CONFLICT' && failure.details?.reason === undefined) return EXPORT_BUSY;
  const { maxEntities, maxRelationships, maxAggregates } = failure.details ?? {};
  return failure.code === 'INVALID_REQUEST' && maxEntities !== undefined && maxRelationships !== undefined && maxAggregates !== undefined ? tooLargeText(failure.message, { maxEntities, maxRelationships, maxAggregates }) : failure.message;
}

function isSourceChanged(failure: ApiFailure): boolean {
  return failure.code === 'ACCESS_DENIED' && 'details' in failure && failure.details?.reason === 'export-source-changed';
}

/** Whether a failed download says the person's access changed since the export was made. */
function isAccessChanged(failure: ApiFailure): boolean {
  return failure.code === 'ACCESS_DENIED' && 'details' in failure && failure.details?.reason === 'access-changed';
}

export interface ExportDialogProps {
  readonly client: ApiClient;
  readonly onClose: () => void;
  /** Called, after the dialog is closed, when the download is refused because access changed. */
  readonly onAccessChanged: () => void;
  /** Called, after the dialog is closed, when the download is refused because the source of the export changed. */
  readonly onSourceChanged: () => void;
  /** Called when the file was handed to the browser. */
  readonly onDone?: () => void;
  readonly save?: typeof saveFile;
  readonly now?: () => Date;
}

/** "Export current view": the format, the lines every export starts with, and the file. */
export function ExportDialog({ client, onClose, onAccessChanged, onSourceChanged, onDone, save = saveFile, now = () => new Date() }: ExportDialogProps) {
  const state = useClientState();
  const investigationId = useStoreSelector(state.investigation, (held) => held.id);
  const notRetrieved = useNotRetrieved();
  const opened = useMemo(() => now().toISOString(), [now]);
  const shown = useMemo(() => state.visibleGraph().nodes.length, [state]);
  const sourceId = useStoreSelector(state.investigation, (held) => held.sourceId) ?? '';
  const [format, setFormat] = useState<PictureFormat>('json');
  const commands = useCanvasCommands();
  const sessionMask = useStoreSelector(state.mask, (held) => held);
  const profile = useProfileWhenProvided();
  const [chosen, setChosen] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });
  const key = useRef(newExportKey());
  const dialog = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const previewId = useId();
  const sendingNow = useRef(false);
  const summaryId = useId();
  const option = useSummaryOption(format, now === undefined ? undefined : () => now().getTime());
  const [include, setInclude] = useState(false);
  const summaryToken = option.kind === 'offered' && include ? option.token : undefined;
  const view = state.visibleGraph();
  const lock: MaskLock | undefined = sessionMask ? 'switch' : isLockedByPolicy(view) ? 'policy' : undefined;
  const maskOn = lock !== undefined || chosen;

  useEffect(() => {
    const behind = document.querySelectorAll(`[${KEY_SCOPE_ATTRIBUTE}="workspace"], [${DIALOG_BEHIND_ATTRIBUTE}]`);
    for (const element of behind) element.setAttribute('inert', '');
    dialog.current?.querySelector<HTMLElement>('input[type="radio"]:checked')?.focus();
    return () => {
      for (const element of behind) element.removeAttribute('inert');
    };
  }, []);

  const stopSending = (next: Outcome): void => {
    sendingNow.current = false;
    setSending(false);
    setOutcome(next);
  };

  /** The picture of the canvas as it is, when it shows the values the file is to show; with the mask added by the button it is drawn from masked data instead, after the server has agreed to the export. */
  const sendPicture = async (refs: ReturnType<typeof exportRequestOf>, id: string, apart: PictureCapture | undefined): Promise<void> => {
    let drawing: Blob | undefined;
    if (apart === undefined) {
      try {
        if (commands === undefined) throw new Error('nothing is drawn');
        drawing = await commands.snapshot(drawingBoundsFor());
      } catch {
        stopSending({ kind: 'picture-failed' });
        return;
      }
    }
    const created = await client.createExport(id, refs, key.current);
    if (!created.ok) {
      key.current = keyAfter(created.failure, key.current);
      stopSending({ kind: 'failed', failure: created.failure });
      return;
    }
    try {
      if (!('header' in created.value)) throw new Error('not a picture');
      if (apart !== undefined) {
        const read = await readMaskedView(client, sourceId, refs, created.value.header);
        if (!read.ok) throw new Error('the masked items cannot be drawn');
        drawing = await apart.draw({ nodes: read.nodes, edges: read.edges }, drawingBoundsFor());
      }
      if (drawing === undefined) throw new Error('nothing is drawn');
      const picture = await composePicture(drawing, created.value.header.lines);
      save({ blob: picture, filename: created.value.filename });
    } catch {
      key.current = newExportKey();
      stopSending({ kind: 'picture-failed' });
      return;
    }
    stopSending({ kind: 'none' });
    onDone?.();
    onClose();
  };

  const send = async (): Promise<void> => {
    if (sendingNow.current || investigationId === null) return;
    sendingNow.current = true;
    setSending(true);
    setOutcome({ kind: 'none' });
    const refs = exportRequestOf(state.visibleGraph(), format, maskOn, summaryToken);
    if (format === 'png') {
      await sendPicture(refs, investigationId, maskOn && !sessionMask ? commands?.capture() : undefined);
      return;
    }
    const created = await client.createExport(investigationId, refs, key.current);
    if (!created.ok) {
      key.current = keyAfter(created.failure, key.current);
      // a token that is refused is refused as one answer: the dialog says the summary could not be included and the next try goes without it
      const refusedSummary = created.failure.code === 'ACCESS_DENIED' && 'details' in created.failure && created.failure.details?.reason === 'summary-refused';
      if (refusedSummary) setInclude(false);
      stopSending(refusedSummary ? { kind: 'summary-refused' } : { kind: 'failed', failure: created.failure });
      return;
    }
    if (!('id' in created.value)) {
      stopSending({ kind: 'picture-failed' });
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
    if (isSourceChanged(downloaded.failure)) {
      onClose();
      onSourceChanged();
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
  const problem = outcome.kind === 'picture-failed' ? PICTURE_FAILURE : outcome.kind === 'summary-refused' ? SUMMARY_REFUSED : failure === undefined ? '' : failureText(failure);
  const failed = outcome.kind !== 'none';
  const lines = [`source: ${sourceId}`, exportedTimeLine(new Date(opened)), `scope: ${EXPORT_SCOPE}`, `coverage: ${remainderLine(shown, notRetrieved)}`, maskOn ? (format === 'png' ? PICTURE_MASKED_LINE : FILE_MASKED_LINE) : 'masking: off'];

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
        <div className="export-summary">
          <label className="export-summary-option">
            <input type="checkbox" className={option.kind === 'offered' ? undefined : 'export-summary-locked'} checked={option.kind === 'offered' && include} disabled={option.kind !== 'offered' || sending} aria-describedby={option.kind === 'disabled' ? summaryId : undefined} onChange={(event) => setInclude(event.target.checked)} />
            {option.kind === 'offered' ? null : <span className="icon icon-lock" aria-hidden="true" />}
            {INCLUDE_SUMMARY}
          </label>
          {option.kind === 'disabled' ? (
            <p id={summaryId} className="export-summary-reason">
              {option.reason}
            </p>
          ) : null}
        </div>
        <MaskButton on={maskOn} lock={lock} fields={sensitiveFieldCount(profile, view)} names={sensitiveFieldNames(profile, view)} disabled={sending} onToggle={() => setChosen((held) => !held)} />
        <p className="export-footnote">{FOOTNOTE}</p>
        <p role="status" className="export-problem">
          {problem}
        </p>
        <div className="export-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={sending}>
            {CANCEL}
          </button>
          <button type="button" className="primary" disabled={sending || investigationId === null} aria-busy={sending} onClick={() => void send()}>
            {sending ? PREPARING : failed ? TRY_AGAIN : downloadLabel(format, maskOn)}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
