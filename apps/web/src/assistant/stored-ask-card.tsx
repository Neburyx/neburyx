import { ASK_RESULT_WORDS, type EdgeRef, type ElementRef, type ReadAskResult } from '@neburyx/contracts';
import { ASK_COPY, pathCapText, pathCutText, pathTitle } from '../ask/copy.js';
import { CountStrip, countFigure, QUALITY_WORDS } from '../ask/answer-card.js';
import { humanize } from '../ask/text.js';
import { noticeText } from '../patterns/copy.js';
import { edgeKey, elementKey } from '../state/keys.js';
import { formatNumber } from '../workspace/scope-text.js';
import { degreeCountText } from '../workspace/degree-text.js';
import { ASSISTANT_COPY, noticeKeptOf, listedText, linesNotKept, noticeEntriesNotKept, pathsNotKept, rowsNotKept } from './copy.js';
import type { RefReads } from './stored-reads.js';

type Row = ReadAskResult['rows'][number];
type End = Extract<ReadAskResult['lines'][number]['item'], object>;

const NOT_AVAILABLE = ASSISTANT_COPY.valueUnavailable;

/** The title of an element as the read under the current mask gave it; the identifier is never put in its place. */
function titleOf(ref: ElementRef, reads: RefReads): string {
  const node = reads.nodes.get(elementKey(ref));
  return node === undefined || node.display.title === '' ? NOT_AVAILABLE : node.display.title;
}

const endText = (end: End, reads: RefReads): string => (end.form === 'withheld' ? ASSISTANT_COPY.storedWithheld : end.form === 'frozen' ? end.text : titleOf(end.ref, reads));

function rowText(row: Row, reads: RefReads): string {
  if (row.form === 'withheld') return ASSISTANT_COPY.storedWithheld;
  if (row.form === 'frozen') return row.text;
  if ('entityType' in row.ref) return titleOf(row.ref, reads);
  const edge = reads.edges.get(edgeKey(row.ref as EdgeRef));
  return edge === undefined ? NOT_AVAILABLE : `${titleOf(edge.from, reads)} → ${edge.type} → ${titleOf(edge.to, reads)}`;
}

const lineText = (line: ReadAskResult['lines'][number], reads: RefReads): string => {
  if (line.item !== undefined) return endText(line.item, reads);
  if (line.count !== undefined && line.shown !== undefined) return `${line.shown} shown · ${degreeCountText(line.count)}${line.more === true ? ' · more on the next page' : ''}`;
  if (line.count !== undefined) return degreeCountText(line.count);
  return `${line.shown ?? 0} found`;
};

/**
 * The result of an earlier Ask answer, drawn as the live card draws it from what the thread kept: the label and the values the person typed, the count with its quality word, the count lines, the notices, the paths and the rows, the rows read by
 * reference under the current mask or kept as the masked text they were written as. What the thread left out is told as the card tells a cut.
 */
export function StoredAskCard({ result, intent, reads }: { readonly result: ReadAskResult; readonly intent: string | undefined; readonly reads: RefReads }) {
  const label = result.label ?? (intent === undefined ? undefined : humanize(intent));
  const omitted = result.omitted;
  return (
    <section className="ask-card" aria-label={ASK_COPY.ready}>
      {label === undefined ? null : (
        <div className="ask-understood">
          <span className="ask-understood-label">{ASK_COPY.understoodAs}</span>
          <span className="ask-tag ask-tag-intent">{label}</span>
          {result.templateId === 'file-query' ? <span className="ask-tag ask-tag-kind">{ASK_COPY.fromFileQuery}</span> : null}
        </div>
      )}
      {result.values.length === 0 ? null : (
        <div className="ask-values">
          <p className="ask-values-title">{ASK_COPY.values}</p>
          <dl className="ask-values-list">
            {result.values.map((entry) => (
              <div key={entry.name} className="ask-values-row">
                <dt>{humanize(entry.name)}</dt>
                <dd>{entry.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {result.stop === undefined ? null : (
        <div className="ask-heavy">
          <div className="ask-count-row">
            <span className="ask-count-figure">{countFigure({ count: result.stop.estimate, noun: 'match' })}</span>
            <span className="ask-heavy-tag">{QUALITY_WORDS[result.stop.estimate.quality]}</span>
          </div>
          <p>{ASK_COPY.stopped}</p>
          <p>{ASK_COPY.heavyBody}</p>
        </div>
      )}
      {result.count === undefined ? null : <CountStrip fact={result.count} />}
      {result.count !== undefined && result.listed !== undefined && result.count.count.value !== result.listed ? <p className="ask-note">{listedText(result.listed)}</p> : null}
      {result.lines.length === 0 ? null : (
        <dl className="ask-lines">
          {result.lines.map((line, index) => (
            <div key={`${line.label}-${index}`} className="ask-line">
              <dt>{line.label}</dt>
              <dd>{lineText(line, reads)}</dd>
            </div>
          ))}
        </dl>
      )}
      {omitted.lines > 0 ? <p className="ask-notice">{linesNotKept(omitted.lines)}</p> : null}
      {result.outcome === 'partial' ? <p className="ask-notice">{result.pathCut?.partial === true ? pathCutText(result.pathCut.retained ?? result.paths.length, result.pathCut.requested ?? result.paths.length) : ASK_COPY.partial}</p> : null}
      {result.pathCut?.capReached === true ? <p className="ask-notice">{pathCapText(result.lines.find((entry) => entry.label === ASK_RESULT_WORDS.paths)?.shown ?? result.paths.length)}</p> : null}
      {result.paths.length === 0 ? null : (
        <ol className="ask-paths" aria-label={ASK_COPY.paths}>
          {result.paths.map((path, index) => (
            <li key={index} className="ask-path">
              <div className="ask-path-head">
                <h4 className="ask-path-title">{pathTitle(index + 1, path.hops)}</h4>
              </div>
              <ol className="ask-path-steps">
                {path.steps.map((step, position) => (
                  <li key={position}>{`${endText(step.from, reads)} → ${endText(step.to, reads)}`}</li>
                ))}
              </ol>
            </li>
          ))}
        </ol>
      )}
      {omitted.paths > 0 ? <p className="ask-notice">{pathsNotKept(omitted.paths)}</p> : null}
      {result.notices.map((notice) => (
        <p key={notice.code} className="ask-notice">
          {noticeText(notice)}
        </p>
      ))}
      {result.noticeTotals.map((entry) => (
        <p key={entry.code} className="ask-notice">
          {noticeKeptOf(entry.total)}
        </p>
      ))}
      {omitted.noticeEntries > 0 ? <p className="ask-notice">{noticeEntriesNotKept(omitted.noticeEntries)}</p> : null}
      {result.rows.length === 0 ? null : (
        <section className="ask-section" aria-label={ASK_COPY.rows}>
          <h4 className="ask-section-title">
            {ASK_COPY.rows} · {result.rows.length} {ASK_COPY.shown}
          </h4>
          <ul className="ask-rows">
            {result.rows.map((row, index) => (
              <li key={index}>{rowText(row, reads)}</li>
            ))}
          </ul>
        </section>
      )}
      {omitted.rows > 0 ? <p className="ask-notice">{rowsNotKept(omitted.rows)}</p> : null}
    </section>
  );
}
