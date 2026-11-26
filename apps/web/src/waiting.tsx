import type { ReactNode } from 'react';

/** The accent line of a wait over rows that stay on screen and stay usable: a spinner and the word, announced politely once. */
export function WaitingLine({ word }: { readonly word: string }) {
  return (
    <p className="waiting-line" role="status">
      <span className="waiting-spinner" aria-hidden="true" />
      {word}
    </p>
  );
}

/** The widths the frames give the bars, in their own pixels; the stylesheet holds one rule for each. */
type BarWidth = 24 | 48 | 58 | 72 | 76 | 81 | 88 | 92 | 96 | 98 | 100 | 110 | 115 | 120 | 128 | 150 | 160 | 166 | 176 | 180 | 196 | 200 | 240 | 262 | 300 | 320 | 330 | 336 | 340 | 348 | 360 | 372 | 420 | 'full';

/** A still placeholder of the shape of what is being read; it says nothing. */
export function Bar({ width, size = 'line' }: { readonly width: BarWidth; readonly size?: 'line' | 'second' | 'middle' | 'block' }) {
  return <span className="skeleton-bar" data-width={width} data-size={size} aria-hidden="true" />;
}

const rowsOf = (count: number): readonly number[] => Array.from({ length: count }, (_unused, index) => index);

/** A first read: the sentence, then still bars in the shape of the rows to come. */
export function LoadingBlock({ sentence, children, className }: { readonly sentence: string; readonly children: ReactNode; readonly className?: string }) {
  return (
    <div className={className === undefined ? 'loading-block' : `loading-block ${className}`} aria-busy="true">
      <p className="loading-line" role="status">
        {sentence}
      </p>
      <div className="loading-shape" aria-hidden="true">
        {children}
      </div>
    </div>
  );
}

/** A pair of widths taken in turn, row by row. */
const inTurn = <T,>(row: number, first: T, second: T): T => (row % 2 === 0 ? first : second);

/** Rows of a card each: a title and a second line, of two lengths in turn. */
export function CardRowsShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-card">
      <Bar width={inTurn(row, 176, 150)} />
      <Bar width={inTurn(row, 372, 330)} size="second" />
    </div>
  ));
}

/** Rows of a table: two columns of two lines, then three single ones. */
export function TableShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-table-row">
      <span>
        <Bar width={inTurn(row, 196, 166)} />
        <Bar width={92} size="second" />
      </span>
      <span>
        <Bar width={inTurn(row, 196, 166)} />
        <Bar width={92} size="second" />
      </span>
      <Bar width={inTurn(row, 81, 72)} />
      <Bar width={inTurn(row, 115, 98)} />
      <Bar width={inTurn(row, 58, 48)} />
    </div>
  ));
}

/** The results of a search: a mark, two lines and a control for each. */
export function ResultsShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-result">
      <span className="skeleton-mark" />
      <span>
        <Bar width={inTurn(row, 240, 200)} />
        <Bar width={inTurn(row, 420, 360)} size="second" />
      </span>
      <span className="skeleton-control" />
    </div>
  ));
}

/** The facets of a search: two groups of a heading and four choices. */
export function FacetsShape() {
  return [0, 1].map((group) => (
    <div key={group} className="skeleton-facets">
      <Bar width={100} />
      {rowsOf(4).map((row) => (
        <span key={row} className="skeleton-facet">
          <span className="skeleton-box" />
          <Bar width={inTurn(row, 128, 96)} />
          <Bar width={24} />
        </span>
      ))}
    </div>
  ));
}

/** A heading over three blocks. */
export function BlocksShape() {
  return (
    <>
      <Bar width={120} />
      {rowsOf(3).map((row) => (
        <Bar key={row} width="full" size="middle" />
      ))}
    </>
  );
}

/** Names and values in two columns, then a heading over three blocks. */
export function DetailsShape() {
  return (
    <>
      {rowsOf(6).map((row) => (
        <span key={row} className="skeleton-pair">
          <Bar width={inTurn(row, 88, 72)} />
          <Bar width={row === 1 || row === 4 ? 150 : inTurn(row, 120, 150)} />
        </span>
      ))}
      <BlocksShape />
    </>
  );
}

/** Notes: their tags, then their sentences. */
export function NotesShape() {
  return (
    <>
      <span className="skeleton-tags">
        <Bar width={76} size="block" />
        <Bar width={110} size="block" />
        <Bar width={128} size="block" />
      </span>
      <Bar width={348} />
      <Bar width={320} />
      <Bar width={196} />
      <Bar width={336} />
      <Bar width={262} />
    </>
  );
}

/** Earlier turns: a question at the right, then an answer. */
export function ThreadShape() {
  return [0, 1].map((turn) => (
    <span key={turn} className="skeleton-turn">
      <span className="skeleton-question" data-turn={turn} />
      <span className="skeleton-tags">
        <Bar width={76} size="block" />
        <Bar width={150} size="block" />
      </span>
      <Bar width={340} />
      <Bar width={300} />
      <Bar width={180} />
    </span>
  ));
}
