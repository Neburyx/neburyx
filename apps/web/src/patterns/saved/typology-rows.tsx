import { useId, useState } from 'react';
import { patternDefinitionSchema, type BuiltInDefinition } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { accentPhrases } from '../accent-phrases.js';
import { extensionTags, failureView, problemText } from '../copy.js';
import { usePatternPreview } from '../run/use-preview.js';
import { RowMenu } from './row-menu.js';
import { SAVED_COPY } from './saved-copy.js';

export interface TypologyActions {
  readonly run: (item: BuiltInDefinition) => void;
  readonly copy: (item: BuiltInDefinition) => void;
}

interface Props {
  readonly items: readonly BuiltInDefinition[];
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly actions: TypologyActions;
}

export function TypologyRows({ items, client, sourceId, sourceName, mask, actions }: Props) {
  return (
    <ul className="pattern-rows">
      {items.map((item) => (
        <TypologyRow key={item.id} item={item} client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} actions={actions} />
      ))}
    </ul>
  );
}

function TypologyRow({ item, client, sourceId, sourceName, mask, actions }: Omit<Props, 'items'> & { readonly item: BuiltInDefinition }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <li className="pattern-row">
      <div className="pattern-row-head">
        <button type="button" className="pattern-row-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          <span className="pattern-row-name">{item.name}</span>
        </button>
        {item.tag === undefined ? null : <span className="pattern-row-badge pattern-row-tag">{item.tag}</span>}
        <span className="pattern-row-end">
          <button type="button" className="primary" aria-label={`${SAVED_COPY.run} ${item.name}`} onClick={() => actions.run(item)}>
            {SAVED_COPY.run}
          </button>
          <RowMenu
            name={item.name}
            items={[
              { key: 'run', label: SAVED_COPY.run, onChoose: () => actions.run(item) },
              { key: 'copy', label: SAVED_COPY.copy, onChoose: () => actions.copy(item) },
            ]}
          />
        </span>
      </div>
      {item.description === undefined ? null : <p className="search-panel-note">{item.description}</p>}
      <div id={panelId} hidden={!open}>
        {open ? <TypologyWords item={item} client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} /> : null}
      </div>
    </li>
  );
}

const withoutStepNumber = (text: string): string => text.replace(/^Step \d+: /, '');

function TypologyWords({ item, client, sourceId, sourceName, mask }: Omit<Props, 'items' | 'actions'> & { readonly item: BuiltInDefinition }) {
  const parsed = patternDefinitionSchema.safeParse(item.definition);
  const definition = parsed.success ? parsed.data : undefined;
  const preview = usePatternPreview(client, sourceId, mask, definition, definition === undefined ? undefined : JSON.stringify(definition));
  const state = preview.state;
  if (definition === undefined) return <p className="patterns-error">{SAVED_COPY.typologyFailed}</p>;
  if (state.kind === 'none' || state.kind === 'loading') {
    return (
      <p className="search-panel-note" role="status">
        {SAVED_COPY.typologyLoading}
      </p>
    );
  }
  if (state.kind === 'failed' || state.kind === 'invalid') {
    return (
      <div className="patterns-state" role="alert">
        <p>{SAVED_COPY.typologyFailed}</p>
        {state.kind === 'failed' ? <p>{failureView(state.failure, sourceName).text}</p> : state.problems.map((problem, index) => <p key={`${problem.code}-${index}`}>{problemText(problem)}</p>)}
        <button type="button" className="secondary" onClick={preview.retry}>
          {SAVED_COPY.tryAgain}
        </button>
      </div>
    );
  }
  const tags = [...new Set(definition.steps.flatMap((step) => extensionTags(step, ', ')))];
  return (
    <section className="pattern-typology-words" aria-label={`${item.name}: ${SAVED_COPY.stepsInWords}`}>
      <h5 className="supernode-label">{SAVED_COPY.stepsInWords}</h5>
      <ol className="pattern-typology-steps">
        <li>{state.preview.start.text}</li>
        {state.preview.steps.map((entry, index) => (
          <li key={index}>
            {accentPhrases(withoutStepNumber(entry.text), [entry.fan?.text ?? '', entry.timeOrder?.text ?? '', entry.closesAtAnchor?.text ?? ''])}
            {entry.conditions.map((condition, row) => (
              <span className="pattern-typology-sub" key={row}>
                {condition.text}
              </span>
            ))}
            {entry.window === undefined ? null : <span className="pattern-typology-sub">{entry.window.text}</span>}
          </li>
        ))}
      </ol>
      {tags.length === 0 ? null : (
        <p className="pattern-typology-tags">
          {tags.map((tag) => (
            <span className="pattern-chip pattern-chip-node" key={tag}>
              {tag}
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
