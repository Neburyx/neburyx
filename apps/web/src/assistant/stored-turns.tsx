import type { AssistantThreadResponse } from '@neburyx/contracts';
import { ASSISTANT_COPY, causeText, earlierText, sourcesText } from './copy.js';
import { storedViewOf, valueFromReads, type ValueOf } from './stored-answer.js';
import type { RefReads } from './stored-reads.js';
import type { ViewAnswer } from './assistant-session.js';
import { StoredAskCard } from './stored-ask-card.js';
import { StoredSources } from './stored-sources.js';
import { ViewAnswerCard, type SourcesControl } from './view-answer-card.js';

type Turn = AssistantThreadResponse['turns'][number];

const routeTag = (route: Turn['route']): string => (route === 'ask' ? ASSISTANT_COPY.routeAsk : route === 'view' ? ASSISTANT_COPY.routeView : ASSISTANT_COPY.routeRefuse);

const rowLabelOf = (turn: Turn): string => `${routeTag(turn.route)}, ${turn.outcome === 'answered' ? ASSISTANT_COPY.storedAnswered : ASSISTANT_COPY.storedRefused}`;

function RowParts({ turn }: { readonly turn: Turn }) {
  return (
    <>
      <span className="assistant-tag">{routeTag(turn.route)}</span>
      <span className="assistant-stored-what">{turn.intent ?? (turn.cause === undefined ? '' : causeText(turn.cause))}</span>
      <span className="assistant-stored-end">{turn.outcome === 'answered' ? ASSISTANT_COPY.storedAnswered : turn.outcome === 'waiting' ? ASSISTANT_COPY.waitingClosed : ASSISTANT_COPY.storedRefused}</span>
      <span className="assistant-stored-count">{sourcesText(turn.citedElements)}</span>
    </>
  );
}

function StoredAnswer({ answer, valueFor, intent, reads }: { readonly answer: NonNullable<Turn['answer']>; readonly valueFor: ValueOf; readonly intent: string | undefined; readonly reads: RefReads }) {
  const view = storedViewOf(answer, valueFor);
  // an answer stored before the model and the coverage were kept has neither, and the card draws neither
  const shown = { status: 'answered', route: 'view', blocks: view.blocks, citations: [], coverage: answer.coverage ?? { retrieval: '', summary: '' }, model: answer.model ?? '', calls: 0 } as unknown as ViewAnswer;
  const sourcesControl = (control: SourcesControl) => <StoredSources entries={view.entries} refs={view.refs} open={control.open} onOpenChange={control.setOpen} focusRequest={control.focusRequest} onFocusHandled={control.onFocusHandled} />;
  // the list of sources stands under the overview of a refusal when there is one, else under the blocks
  const overviewAt = view.refusals.findIndex((refusal) => refusal.overview !== undefined);
  return (
    <>
      {view.askResults.map((result, index) => (
        <StoredAskCard key={index} result={result} intent={intent} reads={reads} />
      ))}
      {view.refusals.map((refusal, index) => (
        <div key={index} className="assistant-stored-refusal">
          <p className="assistant-refusal-sentence">{refusal.sentence}</p>
          {refusal.overview === undefined ? null : <ViewAnswerCard answer={{ ...shown, blocks: refusal.overview }} entries={view.entries} heading={ASSISTANT_COPY.overviewHeading} sources={false} stored {...(index === overviewAt ? { renderSources: sourcesControl } : {})} />}
        </div>
      ))}
      {view.blocks.length === 0 ? null : <ViewAnswerCard answer={shown} entries={view.entries} sources={false} stored {...(overviewAt === -1 ? { renderSources: sourcesControl } : {})} />}
    </>
  );
}

export function StoredTurns({ turns, earlier, reads, drawsValues }: { readonly turns: AssistantThreadResponse['turns']; readonly earlier: number; readonly reads: RefReads; /** Whether some answer shown holds a bound value, so that the reading of values has something to say. */ readonly drawsValues: boolean }) {
  const valueFor = valueFromReads(reads);
  return (
    <section className="assistant-stored" aria-labelledby="assistant-stored-heading">
      <h3 id="assistant-stored-heading" className="visually-hidden">
        {ASSISTANT_COPY.storedHeading}
      </h3>
      <p className="assistant-stored-notice">{ASSISTANT_COPY.storedNotice}</p>
      {drawsValues && reads.loading ? <p className="ask-note" role="status">{ASSISTANT_COPY.valuesLoading}</p> : null}
      {drawsValues && reads.failed ? (
        <p className="ask-note" role="alert">
          {ASSISTANT_COPY.valuesFailed}{' '}
          <button type="button" className="ask-continue" onClick={reads.retry}>
            {ASSISTANT_COPY.tryAgain}
          </button>
        </p>
      ) : null}
      {earlier > 0 ? <p className="ask-note">{earlierText(earlier)}</p> : null}
      <ol className="assistant-stored-list">
        {turns.map((turn) =>
          turn.question === undefined && turn.answer === undefined ? (
            <li key={turn.seq} className="assistant-stored-row" aria-label={rowLabelOf(turn)}>
              <RowParts turn={turn} />
            </li>
          ) : (
            <li key={turn.seq} className="assistant-turn assistant-stored-turn" data-stored-turn={turn.seq}>
              {turn.question === undefined ? null : (
                <p className="assistant-message">
                  <span className="visually-hidden">{ASSISTANT_COPY.you}: </span>
                  {turn.question}
                </p>
              )}
              {turn.answer === undefined ? (
                <p className="assistant-stored-row" aria-label={rowLabelOf(turn)}>
                  <RowParts turn={turn} />
                </p>
              ) : (
                <StoredAnswer answer={turn.answer} valueFor={valueFor} intent={turn.intent} reads={reads} />
              )}
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
