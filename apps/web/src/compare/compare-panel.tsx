import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { SourceProfile } from '@neburyx/contracts';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { useVisibleGraph } from '../state/context.js';
import type { LoadedGraph } from '../state/loaded-graph.js';
import { useStoreSelector } from '../state/store.js';
import { CopyButton } from '../workspace/copy-button.js';
import { columnText, tableText } from './compare-copy-text.js';
import { resolveElements, titleHoldsReference } from './compare-elements.js';
import { buildRows, isQuiet, shareNoProperty, type Cell, type Row } from './compare-model.js';
import type { Compare, CompareTarget } from './compare.js';
import {
  CLOSE_COMPARE,
  COMPARE_PANEL_TITLE,
  COPY_COLUMN,
  COPY_TABLE,
  DIFFERENCES_ONLY,
  FEWER_THAN_TWO,
  FIRST_COLUMN,
  INCLUDES_MASKED,
  MASKED,
  NOT_COMPARED,
  NOTHING_TO_COMPARE,
  NO_DIFFERENCES,
  STATUS_CANNOT,
  STATUS_DIFFERS,
  STATUS_SAME,
  comparingLine,
  removedNote,
  rowsLine,
} from './copy.js';
import { COMPARE_MIN_COLUMN_WIDTH } from './limits.js';

const STATUS_TEXT = { differs: STATUS_DIFFERS, same: STATUS_SAME, cannot: STATUS_CANNOT } as const;

function CellView({ cell }: { readonly cell: Cell }) {
  return (
    <td className="compare-cell" data-kind={cell.kind}>
      <span className="compare-cell-text">{cell.text}</span>
      {cell.kind === 'masked' ? <span className="compare-flag">{MASKED}</span> : null}
    </td>
  );
}

function RowView({ row }: { readonly row: Row }) {
  return (
    <tr className="compare-row" data-status={row.status}>
      <th scope="row" className="compare-row-head">
        <span className="compare-row-label">{row.label}</span>
        <span className="compare-mark" data-status={row.status}>
          {row.status === 'same' ? <span className="visually-hidden">{STATUS_TEXT.same}</span> : <><span className="icon icon-compare-mark" aria-hidden="true" />{STATUS_TEXT[row.status]}</>}
        </span>
        {row.includesMasked ? <span className="compare-flag">{INCLUDES_MASKED}</span> : null}
      </th>
      {row.cells.map((cell, at) => (
        <CellView key={at} cell={cell} />
      ))}
    </tr>
  );
}

export interface ComparePanelViewProps {
  readonly target: CompareTarget;
  readonly graph: LoadedGraph;
  readonly profile: SourceProfile | undefined;
  /** Changes each time the person chooses Compare; the panel then takes the focus. */
  readonly choice: number;
  readonly onClose: () => void;
}

/** The comparison as the dock draws it: a heading, the switch and the copy of the table, a table with a column for each element, and the notes. */
export function ComparePanelView({ target, graph, profile, choice, onClose }: ComparePanelViewProps) {
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const title = useRef<HTMLHeadingElement>(null);
  const handled = useRef(0);
  useEffect(() => {
    if (handled.current === choice) return;
    handled.current = choice;
    queueMicrotask(() => title.current?.focus());
  }, [choice]);
  const resolved = resolveElements(graph, profile, target.columns.map((column) => column.key));
  const headers = resolved.map((entry) => entry.header);
  const all = buildRows(resolved.map((entry) => entry.element));
  const rows = differencesOnly ? all.filter((row) => !isQuiet(row)) : all;
  const enough = headers.length >= 2;
  const leftHeaders = resolveElements(graph, profile, target.left).map((entry) => entry.header);
  return (
    <div
      className="compare-panel"
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="compare-header">
        <div className="compare-heading">
          <h2 className="compare-title" ref={title} tabIndex={-1}>
            {COMPARE_PANEL_TITLE}
          </h2>
          <button type="button" className="legend-close" aria-label={CLOSE_COMPARE} onClick={onClose}>
            <span className="icon icon-clear" aria-hidden="true" />
          </button>
        </div>
        <p className="compare-summary">{comparingLine(target.columns.length + target.gone.length, target.selected)}</p>
      </header>
      {target.gone.length === 0 ? null : (
        <div className="compare-notes" role="status">
          {target.gone.map((name, at) => (
            <p key={at}>{removedNote(name)}</p>
          ))}
        </div>
      )}
      {enough ? (
        <>
          <div className="compare-tools">
            <label className="compare-switch">
              <input type="checkbox" role="switch" checked={differencesOnly} onChange={(event) => setDifferencesOnly(event.target.checked)} />
              <span>{DIFFERENCES_ONLY}</span>
            </label>
            {differencesOnly ? <span className="compare-count">{rowsLine(rows.length, all.length)}</span> : null}
            <CopyButton label={COPY_TABLE} text={tableText(headers, rows, differencesOnly)} align="start" />
          </div>
          {shareNoProperty(all) ? <p className="compare-note">{NOTHING_TO_COMPARE}</p> : null}
          {rows.length === 0 ? (
            <p className="compare-note">{NO_DIFFERENCES}</p>
          ) : (
            <div className="compare-scroll" role="region" aria-label="Comparison table" tabIndex={0}>
              <table className="compare-table" style={{ '--compare-column-min': `${COMPARE_MIN_COLUMN_WIDTH}px` } as CSSProperties}>
                <thead>
                  <tr>
                    <th scope="col" className="compare-corner">
                      {FIRST_COLUMN}
                    </th>
                    {headers.map((header, at) => (
                      <th key={header.key} scope="col" className="compare-column-head" aria-label={header.reference === undefined ? undefined : `${header.title}, ${header.caption}, ${header.reference}`}>
                        <span className="compare-column-title">{header.title}</span>
                        <span className="compare-column-caption">{header.caption}</span>
                        {header.reference === undefined || titleHoldsReference(header.title, header.reference) ? null : <span className="compare-column-reference">{header.reference}</span>}
                        <CopyButton label={`${COPY_COLUMN} ${header.title}`} text={columnText(header, at, rows, differencesOnly)} align={at === 0 ? 'start' : 'end'} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <RowView key={row.id} row={row} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="compare-note">{FEWER_THAN_TWO}</p>
      )}
      {leftHeaders.length === 0 ? null : (
        <section className="compare-left" aria-label={NOT_COMPARED}>
          <h3>{NOT_COMPARED}</h3>
          <ul>
            {leftHeaders.map((header) => (
              <li key={header.key}>{`${header.title} · ${header.caption}`}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** The panel the dock holds: the comparison the person chose, over the loaded view as it is now. */
export function CompareDock({ compare }: { readonly compare: Compare }) {
  const target = useStoreSelector(compare.target, (current) => current);
  const choice = useStoreSelector(compare.choices, (current) => current);
  const graph = useVisibleGraph();
  const profile = useProfileWhenProvided();
  if (target === undefined) return null;
  return <ComparePanelView key={choice} target={target} graph={graph} profile={profile} choice={choice} onClose={() => compare.close()} />;
}
