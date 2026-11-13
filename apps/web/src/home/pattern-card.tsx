import { useNavigate } from 'react-router';
import { canRetry, failureText } from '../failure-notice.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useClientState } from '../state/context.js';
import { PATTERN_CARD_COPY as COPY } from './copy.js';
import { useHomePatterns, type HomePatterns, type SourceChoice } from './home-patterns.js';

type Listed = Extract<HomePatterns, { kind: 'list' }>;

function SourceChooser({ choice }: { readonly choice: SourceChoice }) {
  return (
    <label className="pattern-source">
      <span>{COPY.sourceLabel}</span>
      <select value={choice.chosenId ?? ''} onChange={(event) => choice.choose(event.target.value)}>
        <option value="" disabled>
          {COPY.sourcePlaceholder}
        </option>
        {choice.sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.alias}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Hands the preset to the Patterns panel and opens Explore: on the investigation that is held, or, with none, on the source alone with nothing read, created or saved. */
function useRun(sourceId: string): (presetId: string) => void {
  const state = useClientState();
  const navigate = useNavigate();
  return (presetId) => {
    const held = state.investigation.getState();
    const onHeld = held.id !== null && held.sourceId === sourceId;
    if (!onHeld) state.bindSource(sourceId);
    state.presentation.setPatternsPreset(presetId);
    state.presentation.setPatternsOpen(true);
    navigate(onHeld ? `${EXPLORE_PATH}/${held.id}` : EXPLORE_PATH);
  };
}

function Presets({ patterns }: { readonly patterns: Listed }) {
  const run = useRun(patterns.sourceId);
  const { list } = patterns;
  const data = list.phase === 'ready' || list.phase === 'loading' ? list.data : undefined;
  if (data !== undefined) {
    if (data.presets.length === 0) return <p className="pattern-note">{COPY.noPatterns}</p>;
    return (
      <ul className="pattern-list">
        {data.presets.map((preset) => (
          <li key={preset.id}>
            <span className="pattern-name">{preset.name}</span>
            <button type="button" className="link" aria-label={COPY.runLabel(preset.name)} onClick={() => run(preset.id)}>
              {COPY.run}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  if (list.phase === 'failed') {
    return (
      <div role="alert" className="pattern-failure">
        <p>{COPY.couldNotRead(patterns.sourceName)}</p>
        <p>{failureText(list.failure)}</p>
        {canRetry(list.failure) ? (
          <button type="button" className="secondary" onClick={patterns.reload}>
            {COPY.tryAgain}
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <p className="pattern-note" role="status">
      {COPY.loading}
    </p>
  );
}

function Body({ patterns }: { readonly patterns: Exclude<HomePatterns, { kind: 'hidden' }> }) {
  if (patterns.kind === 'not-configured') return <p className="pattern-note">{COPY.notConfigured(patterns.sourceId)}</p>;
  if (patterns.kind === 'choose') {
    return (
      <>
        <SourceChooser choice={patterns.choice} />
        <p className="pattern-note">{COPY.chooseSource}</p>
      </>
    );
  }
  return (
    <>
      {patterns.choice === undefined ? null : <SourceChooser choice={patterns.choice} />}
      <Presets patterns={patterns} />
    </>
  );
}

/** The card of Home that lists the patterns of the current source, each with the way into the panel on it. */
export function PatternCard() {
  const patterns = useHomePatterns();
  if (patterns.kind === 'hidden') return null;
  return (
    <section className="pattern-card" aria-labelledby="pattern-card-title">
      <h2 id="pattern-card-title">{COPY.title}</h2>
      <Body patterns={patterns} />
    </section>
  );
}
