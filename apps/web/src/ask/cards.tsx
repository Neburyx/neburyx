import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ElementRef, GraphNode } from '@neburyx/contracts';
import { ASK_COPY, BLOCKED_MANY, blockedTitle, moreChoicesText, pickerTitle } from './copy.js';
import type { AskPanel, Card, Clarification, Picker } from './use-ask.js';
import type { BlockedToken } from './ask-model.js';

const chipLabel = (ref: ElementRef): string => `${ref.entityType} · ${ref.stableId}`;

/** A card takes the focus when it is drawn, so the keyboard continues where the answer is. */
function useFocusOnDraw() {
  const card = useRef<HTMLElement>(null);
  useEffect(() => card.current?.focus(), []);
  return card;
}

export function PreviewCard({ card, panel }: { readonly card: Extract<Card, { kind: 'preview' }>; readonly panel: AskPanel }) {
  const { busy, sent, failure } = panel.model;
  const done = sent !== undefined;
  const drawn = useFocusOnDraw();
  return (
    <section className={done ? 'ask-card ask-card-sent' : 'ask-card'} aria-labelledby="ask-preview-title" tabIndex={-1} ref={drawn}>
      <h3 id="ask-preview-title" className="ask-card-title">
        {ASK_COPY.receivesTitle}
      </h3>
      {card.changed ? <p className="ask-note">{ASK_COPY.changedNote}</p> : null}
      <pre className="ask-preview-text" tabIndex={0} aria-label={ASK_COPY.receivesTitle}>
        {card.preview}
      </pre>
      <p className="ask-note">{ASK_COPY.receivesNote}</p>
      <div className="ask-actions">
        <button type="button" className="ask-primary" onClick={panel.send} disabled={busy !== 'idle' || done || failure !== undefined}>
          {ASK_COPY.send}
        </button>
        <button type="button" className="ask-secondary" onClick={panel.editQuestion} disabled={busy !== 'idle'}>
          {ASK_COPY.editQuestion}
        </button>
      </div>
    </section>
  );
}

function PickerView({ picker, panel }: { readonly picker: Picker; readonly panel: AskPanel }) {
  const { token } = picker;
  const limit = panel.limitReached;
  const [query, setQuery] = useState(picker.query);
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => search.current?.focus(), []);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    panel.searchPicker(query);
  };
  return (
    <div className="ask-picker" role="group" aria-label={pickerTitle(token.text)}>
      <h4 className="ask-card-title">{pickerTitle(token.text)}</h4>
      <form className="ask-picker-search" onSubmit={submit}>
        <input ref={search} className="ask-picker-input" type="text" aria-label={ASK_COPY.pickerSearch} value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="ask-secondary">
          {ASK_COPY.pickerSearchButton}
        </button>
      </form>
      {picker.status === 'loading' ? <p className="ask-note">{ASK_COPY.searching}</p> : null}
      {picker.status === 'failed' ? (
        <div className="ask-failure">
          <p>{picker.failure?.text}</p>
          {picker.failure?.action === 'try-again' ? (
            <button type="button" className="ask-secondary" onClick={panel.retryPicker}>
              {ASK_COPY.retry}
            </button>
          ) : null}
        </div>
      ) : null}
      {picker.status === 'ready' && picker.nodes.length === 0 && picker.unreferenced === 0 ? <p className="ask-note">{ASK_COPY.pickerEmpty}</p> : null}
      {picker.status === 'ready' ? (
        <ul className="ask-results">
          {picker.nodes.map((node: GraphNode) => (
            <li key={`${node.ref.entityType}:${node.ref.stableId}`}>
              <button type="button" className="ask-result" disabled={limit} onClick={() => panel.chooseEntity(node)}>
                <span className="ask-result-type">{node.ref.entityType}</span>
                <span className="ask-result-title">{node.display.title === '' ? node.ref.stableId : node.display.title}</span>
              </button>
            </li>
          ))}
          {Array.from({ length: picker.unreferenced }, (_, index) => (
            <li key={`unreferenced-${index}`} className="ask-note">
              {ASK_COPY.pickerNoReference}
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="ask-secondary" onClick={panel.closePicker}>
        {ASK_COPY.cancel}
      </button>
    </div>
  );
}

export function BlockedCard({ tokens, panel }: { readonly tokens: readonly BlockedToken[]; readonly panel: AskPanel }) {
  const { picker } = panel.model;
  const first = tokens[0];
  const limit = panel.limitReached;
  const pickButton = useRef<HTMLButtonElement>(null);
  const hadPicker = useRef(false);
  const drawn = useFocusOnDraw();
  useEffect(() => {
    if (hadPicker.current && picker === undefined) pickButton.current?.focus();
    hadPicker.current = picker !== undefined;
  }, [picker]);
  if (first === undefined) return null;
  return (
    <section className="ask-card ask-card-blocked" aria-labelledby="ask-blocked-title" tabIndex={-1} ref={drawn}>
      <h3 id="ask-blocked-title" className="ask-card-title">
        {tokens.length === 1 ? blockedTitle(first.text) : BLOCKED_MANY}
      </h3>
      {tokens.length > 1 ? (
        <ul className="ask-blocked-list">
          {tokens.map((token) => (
            <li key={token.start}>{`“${token.text}”`}</li>
          ))}
        </ul>
      ) : null}
      {limit ? <p className="ask-note">{ASK_COPY.pickLimit}</p> : null}
      {picker === undefined ? (
        <div className="ask-actions">
          <button type="button" className="ask-secondary" ref={pickButton} disabled={limit} onClick={() => panel.openPicker(first)}>
            {ASK_COPY.pickEntity}
          </button>
          {panel.canUseValue(first) ? (
            <button type="button" className="ask-secondary" disabled={limit} onClick={() => panel.chooseValue(first)}>
              {ASK_COPY.useValue}
            </button>
          ) : null}
          <button type="button" className="ask-secondary" onClick={() => panel.removeWord(first)}>
            {ASK_COPY.removeWord}
          </button>
          <button type="button" className="ask-secondary" onClick={panel.editQuestion}>
            {ASK_COPY.editQuestion}
          </button>
        </div>
      ) : (
        <PickerView picker={picker} panel={panel} />
      )}
    </section>
  );
}

export function ClarificationCard({ clarification, panel }: { readonly clarification: Clarification; readonly panel: AskPanel }) {
  const more = moreChoicesText(clarification.choices.length, clarification.count);
  const drawn = useFocusOnDraw();
  return (
    <section className="ask-card" aria-labelledby="ask-clarify-title" tabIndex={-1} ref={drawn}>
      <h3 id="ask-clarify-title" className="ask-card-title">
        {`${ASK_COPY.doYouMean}…?`}
      </h3>
      {more === undefined ? null : <p className="ask-note">{more}</p>}
      {panel.limitReached ? <p className="ask-note">{ASK_COPY.pickLimit}</p> : null}
      <ul className="ask-chips">
        {clarification.choices.map((ref) => (
          <li key={`${ref.entityType}:${ref.stableId}`}>
            <button type="button" className="ask-chip" disabled={panel.limitReached} onClick={() => panel.chooseChip(ref)}>
              {chipLabel(ref)}
            </button>
          </li>
        ))}
      </ul>
      <div className="ask-actions">
        <button type="button" className="ask-secondary" onClick={panel.cancelClarification}>
          {ASK_COPY.cancel}
        </button>
      </div>
    </section>
  );
}
