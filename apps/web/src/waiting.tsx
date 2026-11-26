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

type BarWidth = 'tag' | 'label' | 'short' | 'medium' | 'long' | 'full';

/** A still placeholder of the shape of what is being read; it says nothing. */
export function Bar({ width, size = 'line' }: { readonly width: BarWidth; readonly size?: 'line' | 'second' | 'block' }) {
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

/** Rows of a card each: a title and a second line, of two lengths in turn. */
export function CardRowsShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-card">
      <Bar width={row % 2 === 0 ? 'short' : 'label'} />
      <Bar width={row % 2 === 0 ? 'medium' : 'short'} size="second" />
    </div>
  ));
}

/** Rows of a table: two columns of two lines, then three single ones. */
export function TableShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-table-row">
      <span>
        <Bar width={row % 2 === 0 ? 'long' : 'medium'} />
        <Bar width="label" size="second" />
      </span>
      <span>
        <Bar width={row % 2 === 0 ? 'long' : 'medium'} />
        <Bar width="label" size="second" />
      </span>
      <Bar width={row % 2 === 0 ? 'medium' : 'short'} />
      <Bar width={row % 2 === 0 ? 'long' : 'medium'} />
      <Bar width={row % 2 === 0 ? 'medium' : 'short'} />
    </div>
  ));
}

/** The results of a search: a mark, two lines and a control for each. */
export function ResultsShape({ rows }: { readonly rows: number }) {
  return rowsOf(rows).map((row) => (
    <div key={row} className="skeleton-result">
      <span className="skeleton-mark" />
      <span>
        <Bar width={row % 2 === 0 ? 'short' : 'label'} />
        <Bar width={row % 2 === 0 ? 'long' : 'medium'} size="second" />
      </span>
      <span className="skeleton-control" />
    </div>
  ));
}

/** The facets of a search: two groups of a heading and four choices. */
export function FacetsShape() {
  return [0, 1].map((group) => (
    <div key={group} className="skeleton-facets">
      <Bar width="label" />
      {rowsOf(4).map((row) => (
        <span key={row} className="skeleton-facet">
          <span className="skeleton-box" />
          <Bar width={row % 2 === 0 ? 'long' : 'medium'} />
          <Bar width="tag" />
        </span>
      ))}
    </div>
  ));
}

/** Names and values in two columns, then a heading over three blocks. */
export function DetailsShape() {
  return (
    <>
      {rowsOf(6).map((row) => (
        <span key={row} className="skeleton-pair">
          <Bar width={row % 2 === 0 ? 'long' : 'medium'} />
          <Bar width={row % 2 === 0 ? 'medium' : 'long'} />
        </span>
      ))}
      <Bar width="label" />
      {rowsOf(3).map((row) => (
        <Bar key={row} width="full" size="block" />
      ))}
    </>
  );
}

/** Notes: their tags, then their sentences. */
export function NotesShape() {
  return (
    <>
      <span className="skeleton-tags">
        <Bar width="tag" size="block" />
        <Bar width="label" size="block" />
        <Bar width="label" size="block" />
      </span>
      <Bar width="full" />
      <Bar width="long" />
      <Bar width="medium" />
      <Bar width="full" />
      <Bar width="long" />
    </>
  );
}

/** Earlier turns: a question at the right, then an answer. */
export function ThreadShape() {
  return [0, 1].map((turn) => (
    <span key={turn} className="skeleton-turn">
      <span className="skeleton-question" />
      <span className="skeleton-tags">
        <Bar width="tag" size="block" />
        <Bar width="label" size="block" />
      </span>
      <Bar width="full" />
      <Bar width="long" />
      <Bar width="medium" />
    </span>
  ));
}
