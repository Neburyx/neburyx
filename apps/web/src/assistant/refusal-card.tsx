import { useId } from 'react';
import { useAiActions } from '../ai/ai-actions.js';
import { UNAVAILABLE_REASON } from '../ai/copy.js';
import { useAiAvailabilityWhenProvided } from '../shell/shell-data.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { isPathsTool } from '../ask/refusal-chips.js';
import { useTools, type RegisteredTool } from '../workspace/tool-registry.js';
import { ASSISTANT_COPY } from './copy.js';

const FILTERS_TOOL_ID = 'filters';
const PATHS_TOOL_ID = 'paths';

function SummarizeChip() {
  const availability = useAiAvailabilityWhenProvided('summary');
  const handlers = useAiActions();
  const handler = useStoreSelector(handlers.view, (held) => held.get('summarize'));
  const reasonId = useId();
  if (availability === 'pending' || handler === undefined) return null;
  if (availability === 'unavailable') {
    return (
      <>
        <button type="button" className="ask-chip assistant-chip-unavailable" aria-disabled="true" aria-describedby={reasonId} title={UNAVAILABLE_REASON} onClick={(event) => event.preventDefault()}>
          {ASSISTANT_COPY.summarizeView}
        </button>
        <span id={reasonId} className="visually-hidden">
          {UNAVAILABLE_REASON}
        </span>
      </>
    );
  }
  return (
    <button type="button" className="ask-chip" onClick={handler}>
      {ASSISTANT_COPY.summarizeView}
    </button>
  );
}

function ToolChip({ tool, label }: { readonly tool: RegisteredTool; readonly label: string }) {
  const state = useClientState();
  if (tool.kind.type !== 'action') return null;
  const { activate, isActive } = tool.kind;
  return (
    <button type="button" className="ask-chip" onClick={() => (isActive?.(state.presentation.view.getState()) === true ? undefined : activate())}>
      {label}
    </button>
  );
}

/** A refusal of the assistant: the title, the fixed sentence of the cause, and the manual ways on. The words of the model never reach it. */
export function RefusalCard({ sentence, hint }: { readonly sentence: string; readonly hint?: string | undefined }) {
  const titleId = useId();
  const tools = useTools();
  const filters = tools.find((tool) => tool.id === FILTERS_TOOL_ID);
  const paths = tools.find((tool) => tool.id === PATHS_TOOL_ID);
  const hasPaths = isPathsTool(paths);
  return (
    <section className="assistant-refusal-region" aria-labelledby={titleId}>
      <div className="assistant-refusal">
        <h3 id={titleId} tabIndex={-1} data-ask-focus="title">
          {ASSISTANT_COPY.notAnswered}
        </h3>
        <p>{sentence}</p>
        <div className="ask-chips">
          {filters === undefined ? null : <ToolChip tool={filters} label={ASSISTANT_COPY.openFilters} />}
          <SummarizeChip />
          {hasPaths && paths !== undefined ? <ToolChip tool={paths} label={ASSISTANT_COPY.openPaths} /> : null}
        </div>
      </div>
      {hint === undefined ? null : <p className="ask-hint">{hint}</p>}
      {hasPaths ? null : <p className="ask-note">{ASSISTANT_COPY.pathsLeftOut}</p>}
    </section>
  );
}
