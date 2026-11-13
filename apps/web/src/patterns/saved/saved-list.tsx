import type { ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import { canRetry } from '../../failure-notice.js';
import { failureView } from '../copy.js';
import type { ApiFailure } from '../../api/client.js';
import { RowMenu, type MenuItem } from './row-menu.js';
import { SAVED_COPY, UNAVAILABLE_TEXT, stepWhere, type Tab } from './saved-copy.js';
import { controlsOf, kindLineOf, lastRunText, tabOf, visibilityText } from './saved-model.js';
import type { SavedList } from './use-saved-patterns.js';

export interface RowActions {
  readonly run: (item: ListedPattern) => void;
  readonly rename: (item: ListedPattern) => void;
  readonly copy: (item: ListedPattern) => void;
  readonly remove: (item: ListedPattern) => void;
  readonly share: (item: ListedPattern) => void;
  readonly unshare: (item: ListedPattern) => void;
  readonly change: (item: ListedPattern) => void;
}

interface Props {
  readonly tab: Exclude<Tab, 'built-in'>;
  readonly list: SavedList;
  readonly sourceName: string;
  readonly presets: TemplateListResponse['presets'] | undefined;
  readonly actions: RowActions;
  /** Whether a run is on its way: Run waits for it. */
  readonly running: boolean;
}

/** One saved tab: the rows of the tab, what could not be read, Load more, and the footnote. The Built-in tab is the panel's own list. */
export function SavedTabPanel({ tab, list, sourceName, presets, actions, running }: Props) {
  const state = list.state;
  if (state.phase === 'loading') {
    return (
      <p className="search-panel-note" role="status">
        {SAVED_COPY.loading}
      </p>
    );
  }
  if (state.phase === 'failed') return <ListFailure failure={state.failure} sourceName={sourceName} retry={list.reload} />;
  const rows = state.items.filter((item) => tabOf(item) === tab);
  return (
    <>
      {state.cursorReset ? (
        <p className="search-panel-note" role="status">
          {SAVED_COPY.cursorReset}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="search-panel-note">{tab === 'mine' ? SAVED_COPY.emptyMine : SAVED_COPY.emptyShared}</p> : null}
      <ul className="pattern-rows">
        {rows.map((item) => (
          <SavedRow key={item.id} item={item} presets={presets} actions={actions} running={running} showOwner={tab === 'shared'} />
        ))}
      </ul>
      {state.moreFailure === undefined ? null : (
        <p className="patterns-error" role="alert">
          {failureView(state.moreFailure, sourceName).text}
        </p>
      )}
      {state.nextCursor === null ? null : (
        <div className="patterns-actions">
          <button type="button" className="secondary" disabled={state.loadingMore} aria-busy={state.loadingMore ? true : undefined} onClick={list.loadMore}>
            {SAVED_COPY.loadMore}
          </button>
        </div>
      )}
      <p className="search-panel-note">{SAVED_COPY.footnote}</p>
    </>
  );
}

function ListFailure({ failure, sourceName, retry }: { readonly failure: ApiFailure; readonly sourceName: string; readonly retry: () => void }) {
  const view = failureView(failure, sourceName);
  return (
    <div className="patterns-state" role="alert">
      <p>{view.text}</p>
      <p>{view.detail}</p>
      {canRetry(failure) ? (
        <button type="button" className="secondary" onClick={retry}>
          {SAVED_COPY.retry}
        </button>
      ) : null}
    </div>
  );
}

function SavedRow({ item, presets, actions, running, showOwner }: { readonly item: ListedPattern; readonly presets: Props['presets']; readonly actions: RowActions; readonly running: boolean; readonly showOwner: boolean }) {
  const controls = controlsOf(item);
  const reasons = item.availability.status === 'unavailable' ? item.availability.reasons : [];
  const reasonId = `pattern-row-${item.id}-reason`;
  const items: MenuItem[] = [
    ...(controls.rename ? [{ key: 'rename', label: SAVED_COPY.rename, onChoose: () => actions.rename(item) }] : []),
    ...(controls.change ? [{ key: 'change', label: SAVED_COPY.change, onChoose: () => actions.change(item) }] : []),
    ...(controls.share ? [{ key: 'share', label: SAVED_COPY.share, onChoose: () => actions.share(item) }] : []),
    ...(controls.unshare ? [{ key: 'unshare', label: SAVED_COPY.unshare, onChoose: () => actions.unshare(item) }] : []),
    ...(controls.copy ? [{ key: 'copy', label: SAVED_COPY.copy, onChoose: () => actions.copy(item) }] : []),
    ...(controls.delete ? [{ key: 'delete', label: SAVED_COPY.delete, onChoose: () => actions.remove(item) }] : []),
  ];
  return (
    <li className="pattern-row">
      <div className="pattern-row-head">
        <h3 className="pattern-row-name">{item.name}</h3>
        {item.availability.status === 'unavailable' ? <span className="pattern-row-flag">{SAVED_COPY.unavailable}</span> : null}
      </div>
      <p className="search-panel-note">{kindLineOf(item, presets)}</p>
      <p className="search-panel-note">
        {lastRunText(item)} · {visibilityText(item)}
        {showOwner ? ` · ${item.owner.name}` : ''}
      </p>
      {reasons.length === 0 ? null : (
        <ul className="pattern-row-reasons" id={reasonId}>
          {reasons.map((reason, index) => (
            <li key={`${reason.code}-${index}`} className="search-panel-note">
              {UNAVAILABLE_TEXT[reason.code]}
              {stepWhere(reason.path)}
            </li>
          ))}
        </ul>
      )}
      <div className="patterns-actions">
        <button type="button" className="primary" disabled={!controls.run || running} aria-label={`${SAVED_COPY.run} ${item.name}`} aria-describedby={controls.run ? undefined : reasonId} onClick={() => actions.run(item)}>
          {SAVED_COPY.run}
        </button>
        <RowMenu name={item.name} items={items} />
      </div>
    </li>
  );
}
