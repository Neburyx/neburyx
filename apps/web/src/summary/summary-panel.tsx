import { useEffect, useRef } from 'react';
import { MENU_BUTTON_LABEL } from '../lifecycle/copy.js';
import { SUMMARY_COPY, sentencesText } from './copy.js';
import { DraftCard } from './draft-card.js';
import { NotesSection } from './notes-section.js';
import { OutcomeCard } from './outcome-card.js';
import { useSummary } from './use-summary.js';

function focusSummarizeControl(fromMenu: boolean): void {
  if (fromMenu) {
    const menu = document.querySelector<HTMLElement>(`button[aria-label="${MENU_BUTTON_LABEL}"]`);
    if (menu !== null) {
      menu.focus();
      return;
    }
  }
  const controls = [...document.querySelectorAll<HTMLElement>('.header-ai')];
  controls.find((control) => control.textContent?.trim().startsWith('Summarize'))?.focus();
}

function Sparkle() {
  return (
    <svg aria-hidden="true" className="summary-sparkle" viewBox="0 0 12 12" fill="currentColor">
      <path d="M5 1l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" />
      <path d="M9.5 7.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5L7.5 9.5 9 9z" />
    </svg>
  );
}

export function SummaryPanel({ onClose, returnToGraph }: { readonly onClose: () => void; readonly returnToGraph: () => void }) {
  const fromMenu = useRef(false);
  const model = useSummary(() => {
    onClose();
    focusSummarizeControl(fromMenu.current);
  });
  fromMenu.current = model.notesOnly;
  const body = useRef<HTMLDivElement>(null);
  const { draft, attempt } = model.state;
  const generating = attempt.kind === 'generating';
  const outcome = attempt.kind === 'outcome' ? attempt.outcome : undefined;
  const begin = useRef(model.begin);
  useEffect(() => {
    begin.current = model.begin;
  });
  useEffect(() => begin.current(), []);
  useEffect(() => {
    const target = model.focus.target;
    if (target !== undefined) body.current?.querySelector<HTMLElement>(`[data-summary-focus="${target}"]`)?.focus();
  }, [model.focus]);
  const announced = generating ? SUMMARY_COPY.generating : outcome !== undefined ? '' : draft !== undefined ? `${SUMMARY_COPY.drafted}, ${sentencesText(draft.response.sentences.length)}` : '';

  return (
    <div
      className="summary-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        model.escape();
      }}
    >
      <header className="summary-head">
        <Sparkle />
        <div className="summary-head-text">
          <h2 id="summary-panel-title">{SUMMARY_COPY.title}</h2>
          <p>{model.investigationTitle}</p>
        </div>
        <button type="button" className="summary-close" aria-label={SUMMARY_COPY.close} onClick={model.close}>
          ×
        </button>
      </header>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announced}
      </p>
      <div className="summary-body" ref={body}>
        {draft === undefined ? (
          <div className="summary-tags">
            <span className="summary-tag summary-tag-accent">{SUMMARY_COPY.drafted}</span>
          </div>
        ) : null}
        {draft === undefined && !generating && (outcome === undefined || outcome.kind === 'cleared') ? (
          <>
            {outcome === undefined ? <p className="summary-intro">{SUMMARY_COPY.intro}</p> : null}
            <button type="button" className="summary-button" data-summary-focus="start" disabled={model.sourceChanged} onClick={model.generate}>
              {SUMMARY_COPY.summarize}
            </button>
          </>
        ) : null}
        {generating ? (
          <section className="summary-generating" aria-label={SUMMARY_COPY.generating}>
            <h3 className="summary-generating-title">{SUMMARY_COPY.generating}</h3>
            <ul className="summary-steps">
              {SUMMARY_COPY.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
            <div className="summary-actions">
              <button type="button" className="summary-button summary-button-outline" data-summary-focus="cancel" onClick={model.cancel}>
                {SUMMARY_COPY.cancel}
              </button>
              <span className="summary-note">{SUMMARY_COPY.graphUnchanged}</span>
            </div>
          </section>
        ) : null}
        {outcome !== undefined ? <OutcomeCard outcome={outcome} sourceId={model.sourceId ?? ''} onTryAgain={model.generate} onReturn={returnToGraph} /> : null}
        {draft !== undefined ? <DraftCard draft={draft} previous={generating || outcome !== undefined} busy={generating} note={model.note} copy={model.state.copy} sourceId={model.sourceId ?? ''} onCopy={model.copy} onEdit={model.edit} onPress={model.press} onRegenerate={model.generate} onDiscard={model.discard} /> : null}
      </div>
      <div className="summary-body">
        <NotesSection copies={model.state.copies} sourceId={model.sourceId ?? ''} request={model.notesRequests} />
      </div>
      <footer className="summary-foot">{draft === undefined ? `${SUMMARY_COPY.rule} ${SUMMARY_COPY.notAFinding}` : SUMMARY_COPY.notAFinding}</footer>
    </div>
  );
}
