import { RowMenu, type MenuEntry } from '../saved/row-menu.js';
import { SAVED_COPY } from '../saved/saved-copy.js';
import { ReasonSentences } from '../run/state-views.js';
import { LIBRARY_COPY } from './library-copy.js';
import type { LibraryRow } from './library-model.js';

export interface TableEntry {
  readonly row: LibraryRow;
  readonly onRun: () => void;
  readonly canRun: boolean;
  readonly menu?: readonly MenuEntry[];
}

const COLUMNS = LIBRARY_COPY.columns;

export function LibraryTable({ entries, label }: { readonly entries: readonly TableEntry[]; readonly label: string }) {
  return (
    <table className="library-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{COLUMNS.name}</th>
          <th scope="col">{COLUMNS.pattern}</th>
          <th scope="col">{COLUMNS.parameters}</th>
          <th scope="col">{COLUMNS.lastRun}</th>
          <th scope="col">{COLUMNS.visibility}</th>
          <th scope="col">
            <span className="visually-hidden">{COLUMNS.actions}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map(({ row, onRun, canRun, menu }) => {
          const reasonId = `library-row-${row.key}-reason`;
          return (
            <tr key={row.key}>
              <th scope="row" className="library-name">
                <span>{row.name}</span>
                {row.reasons.length === 0 ? null : (
                  <>
                    <span className="pattern-row-flag">{SAVED_COPY.unavailable}</span>
                    <div className="pattern-row-reasons" id={reasonId}>
                      <ReasonSentences reasons={row.reasons} />
                    </div>
                  </>
                )}
              </th>
              <td>{row.pattern}</td>
              <td>{row.parameters}</td>
              <td>{row.lastRun}</td>
              <td>
                <span className="library-pill">{row.visibility}</span>
              </td>
              <td className="library-actions">
                <button type="button" className="secondary" disabled={!canRun} aria-label={`${LIBRARY_COPY.run} ${row.name}`} aria-describedby={canRun || row.reasons.length === 0 ? undefined : reasonId} onClick={onRun}>
                  {LIBRARY_COPY.run}
                </button>
                {menu === undefined ? null : <RowMenu name={row.name} items={menu} />}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
