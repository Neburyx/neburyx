import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { useApiClient } from '../api/client-context.js';
import type { ApiFailure } from '../api/client.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { messageOf } from '../lifecycle/status-flow.js';
import { DIALOG_BEHIND_ATTRIBUTE } from '../lifecycle/dialog-behind.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { CANNOT_RESTORE, CLEAR_FILTERS, COULD_NOT_READ, EMPTY, NO_DELETED, RESTORED, EVIDENCE_LOCKED, EVIDENCE_PANEL, GO_HOME, LOADING, LOADING_MORE, MORE_FAILED, NO_MATCH, PAGE_DESCRIPTION, PAGE_TITLE, SHOW_MORE, TABS_LABEL, TAB_EVIDENCE_PACKS, TAB_INVESTIGATIONS, TAB_SAVED_VIEWS, TRY_AGAIN, showing, tabWithCount } from './copy.js';
import { DeletedTable } from './deleted-table.js';
import { FilterBar } from './filter-bar.js';
import { InvestigationsTable } from './investigations-table.js';
import { SavedViewsTab } from './saved-views-tab.js';
import { Tabs } from './tabs.js';
import { NO_ROW_LEFT, useInvestigationList, type ListFilters } from './use-investigation-list.js';
import { useRowLabels } from './use-row-labels.js';
import { useSourceProfiles } from './use-source-profiles.js';

const TABS = { investigations: 'investigations', views: 'views', evidence: 'evidence' } as const;
type TabId = (typeof TABS)[keyof typeof TABS];

const STATUSES = ['open', 'closed', 'archived'] as const;

function tabOf(value: string | null): TabId {
  return value === TABS.views || value === TABS.evidence ? value : TABS.investigations;
}

function filtersOf(params: URLSearchParams): ListFilters {
  const deleted = params.get('deleted') === '1';
  const status = deleted ? 'open' : (STATUSES.find((candidate) => candidate === params.get('status')) ?? 'open');
  const source = params.get('source');
  const text = params.get('q');
  return { status, ...(deleted ? { deleted } : {}), sourceId: source === null || source === '' ? undefined : source, text: text === null || text.trim() === '' ? undefined : text };
}

const isDefault = (filters: ListFilters): boolean => filters.status === 'open' && filters.deleted !== true && filters.sourceId === undefined && filters.text === undefined;

/** The note a deletion from the workspace left in the address state, to be said once on arrival. */
function arrivalNoteOf(state: unknown): string | undefined {
  if (typeof state !== 'object' || state === null || !('notice' in state)) return undefined;
  return typeof state.notice === 'string' ? state.notice : undefined;
}

/** `/investigations`: the caller's investigations a page at a time, with filters and a menu on each row, their named views across investigations, and the Evidence packs tab, which this edition locks. */
export function InvestigationsPage() {
  const client = useApiClient();
  const [params, setParams] = useSearchParams();
  const tab = tabOf(params.get('tab'));
  const filters = useMemo(() => filtersOf(params), [params]);
  const list = useInvestigationList(client, filters);
  const sources = answeredData(useShellData().sources)?.items ?? [];
  const [onlySource, ...otherSources] = sources;
  const location = useLocation();
  const [viewsDeleted, setViewsDeleted] = useState(0);
  const navigate = useNavigate();
  const [arrival, setArrival] = useState<string | undefined>(() => arrivalNoteOf(location.state));
  // said once: a reload or Back must not announce it again
  useEffect(() => {
    if (arrivalNoteOf(location.state) !== undefined) void navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
  }, [location.pathname, location.search, location.state, navigate]);
  const [notice, setNotice] = useState<ApiFailure | undefined>(undefined);
  const { state } = list;
  // the count of the Saved views tab is the list's last answer less the views deleted since
  useEffect(() => setViewsDeleted(0), [state.savedViews]);
  const profiles = useSourceProfiles(client, (state.items ?? []).map((item) => item.sourceId));
  // a deleted investigation is not read from its source, so its row carries no label
  const labels = useRowLabels(client, filters.deleted === true ? undefined : state.items, JSON.stringify([filters.status, filters.sourceId, filters.text]));

  const changeFilters = useCallback(
    (next: ListFilters): void => {
      setNotice(undefined);
      setArrival(undefined);
      setParams(
        (held) => {
          const updated = new URLSearchParams(held);
          for (const name of ['status', 'source', 'q', 'deleted']) updated.delete(name);
          if (next.deleted === true) updated.set('deleted', '1');
          else if (next.status !== 'open') updated.set('status', next.status);
          if (next.sourceId !== undefined) updated.set('source', next.sourceId);
          if (next.text !== undefined) updated.set('q', next.text);
          return updated;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const selectTab = (id: string): void => {
    setParams(
      (held) => {
        const updated = new URLSearchParams(held);
        if (id === TABS.investigations) updated.delete('tab');
        else updated.set('tab', id);
        return updated;
      },
      { replace: false },
    );
  };

  const items = state.items;
  const emptyMessage = useRef<HTMLParagraphElement>(null);
  const { focusId, focusTaken } = { focusId: state.focusId, focusTaken: list.focusTaken };
  useEffect(() => {
    if (focusId !== NO_ROW_LEFT || items === undefined || items.length > 0 || state.refocusFirst) return;
    emptyMessage.current?.focus();
    focusTaken();
  }, [focusId, items, focusTaken, state.refocusFirst]);
  const statusText =
    state.note ?? arrival ?? (items === undefined ? (state.failure === undefined ? LOADING : '') : items.length === 0 || state.matching === undefined ? '' : showing(items.length, state.matching));

  const investigationsPanel = (
    <>
      <FilterBar filters={filters} sources={sources} onChange={changeFilters} retentionDays={state.retentionDays} />
      <p role="status" className="investigations-status">
        {statusText}
      </p>
      {notice === undefined ? null : (
        <p role="alert" className="investigations-notice">
          {messageOf(notice)}
        </p>
      )}
      {state.failure === undefined ? null : (
        <div className="investigations-failure">
          <p>{state.failure.where === 'more' ? MORE_FAILED : COULD_NOT_READ}</p>
          <FailureNotice failure={state.failure.failure} />
          {canRetry(state.failure.failure) ? (
            <button type="button" className="secondary" onClick={state.failure.where === 'more' ? list.showMore : list.retry}>
              {TRY_AGAIN}
            </button>
          ) : null}
        </div>
      )}
      {items === undefined ? null : items.length === 0 ? (
        state.loading || state.refocusFirst || state.failure !== undefined ? null : filters.deleted === true && filters.sourceId === undefined && filters.text === undefined ? (
          <p ref={emptyMessage} tabIndex={-1} className="investigations-empty">
            {NO_DELETED}
          </p>
        ) : isDefault(filters) ? (
          <p ref={emptyMessage} tabIndex={-1} className="investigations-empty">
            {EMPTY} <Link to="/">{GO_HOME}</Link>
          </p>
        ) : (
          <p ref={emptyMessage} tabIndex={-1} className="investigations-empty">
            {NO_MATCH}{' '}
            <button type="button" className="secondary" onClick={() => changeFilters({ status: 'open', sourceId: undefined, text: undefined })}>
              {CLEAR_FILTERS}
            </button>
          </p>
        )
      ) : (
        <>
          {filters.deleted === true ? (
            <DeletedTable
              items={items}
              profiles={profiles}
              busy={state.loading}
              focusId={state.focusId}
              onFocusTaken={list.focusTaken}
              client={client}
              onRestored={(item) => list.removeRow(item.id, RESTORED)}
              onGone={(item) => list.removeRow(item.id, CANNOT_RESTORE)}
              onStale={list.retry}
              onNotice={setNotice}
            />
          ) : (
          <InvestigationsTable
            items={items}
            profiles={profiles}
            labels={labels}
            busy={state.loading}
            focusId={state.focusId}
            onFocusTaken={list.focusTaken}
            client={client}
            statusFilter={filters.status}
            onChanged={list.replaceRow}
            onLeft={(item, note) => list.removeRow(item.id, note)}
            onNotice={setNotice}
            onDeleted={(item, note) => list.removeRow(item.id, note)}
            onGone={(item) => {
              list.removeRow(item.id, '');
              list.retry();
            }}
            onStale={list.retry}
          />
          )}
          {state.nextCursor === null ? null : (
            <button type="button" className="secondary investigations-more" aria-busy={state.loadingMore ? true : undefined} onClick={list.showMore}>
              {state.loadingMore ? LOADING_MORE : SHOW_MORE}
            </button>
          )}
        </>
      )}
    </>
  );

  return (
    <section className="investigations-page" {...{ [DIALOG_BEHIND_ATTRIBUTE]: '' }}>
        <PageHeading title={PAGE_TITLE} description={PAGE_DESCRIPTION} source={onlySource !== undefined && otherSources.length === 0 ? { alias: onlySource.alias, synthetic: onlySource.synthetic } : null} />
        <Tabs
          idBase="investigations"
          label={TABS_LABEL}
          active={tab}
          onSelect={selectTab}
          tabs={[
            { id: TABS.investigations, label: tabWithCount(TAB_INVESTIGATIONS, items === undefined || filters.deleted === true ? undefined : state.matching), panel: investigationsPanel },
            { id: TABS.views, label: tabWithCount(TAB_SAVED_VIEWS, state.savedViews === undefined ? undefined : Math.max(0, state.savedViews - viewsDeleted)), panel: <SavedViewsTab onViewDeleted={() => setViewsDeleted((held) => held + 1)} /> },
            { id: TABS.evidence, label: TAB_EVIDENCE_PACKS, unavailable: EVIDENCE_LOCKED, panel: <p>{EVIDENCE_PANEL}</p> },
          ]}
        />
    </section>
  );
}
