import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { BuiltInDefinition, ListedPattern, SourceSummary, TemplateListResponse } from '@neburyx/contracts';
import { useApiClient } from '../../api/client-context.js';
import { useRequest } from '../../api/use-request.js';
import { FailureNotice } from '../../failure-notice.js';
import { EXPLORE_PATH } from '../../shell/navigation.js';
import { PageHeading } from '../../shell/page-heading.js';
import { useClientState } from '../../state/context.js';
import { failureView } from '../copy.js';
import { ListUnreadable } from '../run/state-views.js';
import { groupsOf, menuOf, type RowActions } from '../saved/saved-list.js';
import { SAVED_COPY } from '../saved/saved-copy.js';
import { controlsOf, countText } from '../saved/saved-model.js';
import { RowDialogs, useRowActions, type Notice } from '../saved/use-row-actions.js';
import { useSavedPatterns } from '../saved/use-saved-patterns.js';
import { LIBRARY_COPY } from './library-copy.js';
import { definitionRowOf, presetRowOf, savedRowOf } from './library-model.js';
import { LibraryTable, type TableEntry } from './library-table.js';
import { useLibrarySource } from './use-library-source.js';

type Preset = TemplateListResponse['presets'][number];
type Tab = 'mine' | 'shared' | 'built-in';

const TABS: readonly Tab[] = ['mine', 'shared', 'built-in'];

function Tabs({ labels, active, onChoose, panelId }: { readonly labels: Readonly<Record<Tab, string>>; readonly active: Tab; readonly onChoose: (tab: Tab) => void; readonly panelId: string }) {
  const id = useId();
  const refs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const move = (to: Tab): void => {
    onChoose(to);
    refs.current[to]?.focus();
  };
  return (
    <div role="tablist" aria-label={LIBRARY_COPY.tabsLabel} className="library-tabs">
      {TABS.map((tab, index) => (
        <button
          key={tab}
          ref={(node) => {
            refs.current[tab] = node;
          }}
          type="button"
          role="tab"
          id={`${id}-${tab}`}
          aria-selected={active === tab}
          aria-controls={panelId}
          tabIndex={active === tab ? 0 : -1}
          className="library-tab"
          onClick={() => onChoose(tab)}
          onKeyDown={(event) => {
            const next = event.key === 'ArrowRight' ? TABS[(index + 1) % TABS.length] : event.key === 'ArrowLeft' ? TABS[(index + TABS.length - 1) % TABS.length] : event.key === 'Home' ? TABS[0] : event.key === 'End' ? TABS[TABS.length - 1] : undefined;
            if (next === undefined) return;
            event.preventDefault();
            move(next);
          }}
        >
          {labels[tab]}
        </button>
      ))}
    </div>
  );
}

/** Hands a pattern to the Patterns panel and opens Explore: on the investigation that is held, or, with none, on the source alone with nothing read, created or saved. */
function useOpenInPanel(sourceId: string): (hand: () => void) => void {
  const state = useClientState();
  const navigate = useNavigate();
  return (hand) => {
    const held = state.investigation.getState();
    const onHeld = held.id !== null && held.sourceId === sourceId;
    if (!onHeld) state.bindSource(sourceId);
    hand();
    state.presentation.setPatternsOpen(true);
    navigate(onHeld ? `${EXPLORE_PATH}/${held.id}` : EXPLORE_PATH);
  };
}

function LibraryBody({ source }: { readonly source: SourceSummary }) {
  const client = useApiClient();
  const state = useClientState();
  const openInPanel = useOpenInPanel(source.id);
  const saved = useSavedPatterns(client, source.id);
  const loadTemplates = useCallback((signal: AbortSignal) => client.listTemplates(source.id, signal), [client, source.id]);
  const templates = useRequest(loadTemplates);
  const loadProfile = useCallback((signal: AbortSignal) => client.getProfile(source.id, signal), [client, source.id]);
  const profile = useRequest(loadProfile);
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const rows = useRowActions(client, saved.reload, setNotice);
  const [tab, setTab] = useState<Tab>('mine');
  const panelId = useId();
  const panel = useRef<HTMLDivElement>(null);

  const templateData = templates.state.phase === 'ready' || templates.state.phase === 'loading' ? templates.state.data : undefined;
  const presets: readonly Preset[] | undefined = templateData?.presets;
  const definitions: readonly BuiltInDefinition[] | undefined = templateData === undefined ? undefined : (templateData.builtInDefinitions ?? []);
  const profileData = profile.state.phase === 'ready' || profile.state.phase === 'loading' ? profile.state.data : undefined;
  const nameOf = useMemo(() => {
    const names = new Map((profileData?.entityTypes ?? []).map((type) => [type.type, type.displayName]));
    return (type: string): string => names.get(type) ?? type;
  }, [profileData]);

  const list = saved.state;
  const items = list.phase === 'ready' ? list.items : undefined;
  const more = list.phase === 'ready' && list.nextCursor !== null;
  const mine = useMemo(() => (items ?? []).filter((item) => item.ownedByYou), [items]);
  const shared = useMemo(() => (items ?? []).filter((item) => !item.ownedByYou), [items]);
  const builtInCount = presets === undefined || definitions === undefined ? undefined : presets.length + definitions.length;

  const previousRows = useRef(mine.length);
  useEffect(() => {
    // a row that goes (a delete) takes the focus with it: the tab panel is where it goes
    if (mine.length < previousRows.current && document.activeElement === document.body) panel.current?.focus();
    previousRows.current = mine.length;
  }, [mine.length]);

  const actions: RowActions = {
    run: (item) => openInPanel(() => state.presentation.setPatternsSaved({ id: item.id, action: 'run' })),
    runPreset: (preset) => openInPanel(() => state.presentation.setPatternsPreset(preset.id)),
    rename: (item) => rows.open('rename', item),
    copy: rows.copy,
    remove: (item) => rows.open('delete', item),
    share: (item) => rows.open('share', item),
    unshare: rows.unshare,
    change: (item) => openInPanel(() => state.presentation.setPatternsSaved({ id: item.id, action: 'change' })),
    copyAndChange: rows.copy,
    newPattern: () => undefined,
  };
  const runDefinition = (definition: BuiltInDefinition): void => openInPanel(() => state.presentation.setPatternsBuiltIn({ id: definition.id, action: 'run' }));
  const copyDefinition = (definition: BuiltInDefinition): void => openInPanel(() => state.presentation.setPatternsBuiltIn({ id: definition.id, action: 'copy' }));

  const now = Date.now();
  const savedEntries = (of: readonly ListedPattern[]): readonly TableEntry[] =>
    of.map((item) => ({ row: savedRowOf(item, presets, nameOf, now), canRun: controlsOf(item).run, onRun: () => actions.run(item), menu: menuOf(item, actions) }));
  const definitionEntry = (definition: BuiltInDefinition): TableEntry => ({
    row: definitionRowOf(definition),
    canRun: true,
    onRun: () => runDefinition(definition),
    menu: [
      { key: 'run', label: SAVED_COPY.run, onChoose: () => runDefinition(definition) },
      { key: 'copy', label: SAVED_COPY.copy, onChoose: () => copyDefinition(definition) },
    ],
  });
  const presetEntries: readonly TableEntry[] = (presets ?? []).map((preset) => ({ row: presetRowOf(preset, nameOf), canRun: true, onRun: () => actions.runPreset(preset) }));
  const groups = groupsOf(definitions, '');
  const builtInSections = [
    { label: groups.named.length === 0 ? LIBRARY_COPY.builtIn : `${LIBRARY_COPY.builtIn} · ${SAVED_COPY.builtInGeneral}`, entries: [...groups.general.map(definitionEntry), ...presetEntries] },
    ...groups.named.map((group) => ({ label: `${LIBRARY_COPY.builtIn} · ${group.name}`, entries: group.items.map(definitionEntry) })),
  ].filter((section) => section.entries.length > 0);
  const labels: Record<Tab, string> = {
    mine: list.phase === 'ready' ? `${LIBRARY_COPY.mine} · ${countText(mine.length, more)}` : LIBRARY_COPY.mine,
    shared: list.phase === 'ready' ? `${LIBRARY_COPY.shared} · ${countText(shared.length, more)}` : LIBRARY_COPY.shared,
    'built-in': builtInCount === undefined ? LIBRARY_COPY.builtIn : `${LIBRARY_COPY.builtIn} · ${builtInCount}`,
  };
  const tabEntries = tab === 'mine' ? savedEntries(mine) : tab === 'shared' ? savedEntries(shared) : [];
  const emptyText = tab === 'mine' ? LIBRARY_COPY.emptyMine : SAVED_COPY.emptyShared;
  const savedTab = tab !== 'built-in';
  const namesFailed = (profile.state.phase === 'failed' || templates.state.phase === 'failed') && !(tab === 'built-in' && builtInCount === undefined);
  const retryNames = (): void => {
    if (profile.state.phase === 'failed') profile.reload();
    if (templates.state.phase === 'failed') templates.reload();
  };

  let body;
  if (savedTab && list.phase === 'failed') body = <ListUnreadable failure={list.failure} sourceName={source.alias} retry={saved.reload} />;
  else if (savedTab && list.phase === 'loading') {
    body = (
      <p className="search-panel-note" role="status">
        {LIBRARY_COPY.loading}
      </p>
    );
  } else if (!savedTab && builtInCount === undefined) {
    body =
      templates.state.phase === 'failed' ? (
        <div role="alert" className="sources-failure">
          <FailureNotice failure={templates.state.failure} />
          <button type="button" className="secondary" onClick={templates.reload}>
            {LIBRARY_COPY.tryAgain}
          </button>
        </div>
      ) : (
        <p className="search-panel-note">{LIBRARY_COPY.loading}</p>
      );
  } else if (!savedTab) {
    body =
      builtInCount === 0 ? (
        <p className="search-panel-note">{LIBRARY_COPY.noBuiltIn}</p>
      ) : (
        <>
          {builtInSections.map((section) => (
            <section key={section.label} aria-label={section.label}>
              {builtInSections.length > 1 ? <h3 className="pattern-section-heading">{section.label}</h3> : null}
              <LibraryTable entries={section.entries} label={section.label} />
            </section>
          ))}
        </>
      );
  } else if (tabEntries.length === 0 && more) {
    body = (
      <p className="search-panel-note" role="status">
        {LIBRARY_COPY.nonePartial}
      </p>
    );
  } else if (tabEntries.length === 0) body = <p className="search-panel-note">{emptyText}</p>;
  else body = <LibraryTable entries={tabEntries} label={labels[tab]} />;

  return (
    <>
      {notice === undefined ? null : (
        <p className="search-panel-note" role={notice.tone === 'problem' ? 'alert' : 'status'}>
          {notice.text}
        </p>
      )}
      {namesFailed ? (
        <div role="alert" className="sources-failure">
          <p>{LIBRARY_COPY.namesFailed}</p>
          <button type="button" className="secondary" onClick={retryNames}>
            {LIBRARY_COPY.tryAgain}
          </button>
        </div>
      ) : null}
      <Tabs labels={labels} active={tab} onChoose={setTab} panelId={panelId} />
      <div role="tabpanel" id={panelId} ref={panel} tabIndex={-1} aria-label={labels[tab]} className="library-panel">
        {savedTab && list.phase === 'ready' && list.cursorReset ? (
          <p className="search-panel-note" role="status">
            {SAVED_COPY.cursorReset}
          </p>
        ) : null}
        {body}
        {savedTab && list.phase === 'ready' && list.moreFailure !== undefined ? (
          <p className="patterns-error" role="alert">
            {failureView(list.moreFailure, source.alias).text}
          </p>
        ) : null}
        {savedTab && list.phase === 'ready' && list.nextCursor !== null ? (
          <div className="patterns-actions">
            <button type="button" className="secondary" disabled={list.loadingMore} aria-busy={list.loadingMore ? true : undefined} onClick={saved.loadMore}>
              {SAVED_COPY.loadMore}
            </button>
          </div>
        ) : null}
        {tab === 'shared' ? <p className="search-panel-note">{SAVED_COPY.footnote}</p> : null}
        <p className="search-panel-note library-footnote">{LIBRARY_COPY.footnote}</p>
      </div>
      <RowDialogs actions={rows} />
    </>
  );
}

export function LibraryPage() {
  const [params] = useSearchParams();
  const source = useLibrarySource(params.get('source'));
  const synthetic = source.kind === 'ready' && source.source.synthetic;
  return (
    <section className="library-page">
      <PageHeading title={LIBRARY_COPY.title} description={LIBRARY_COPY.description} source={null} {...(synthetic ? { tag: LIBRARY_COPY.synthetic } : {})} />
      {source.kind === 'loading' ? (
        <p role="status">{LIBRARY_COPY.loadingSources}</p>
      ) : source.kind === 'failed' ? (
        <div role="alert" className="sources-failure">
          <p>{LIBRARY_COPY.sourcesFailed}</p>
          <FailureNotice failure={source.failure} />
          <button type="button" className="secondary" onClick={source.retry}>
            {LIBRARY_COPY.tryAgain}
          </button>
        </div>
      ) : source.kind === 'none' ? (
        <p>{LIBRARY_COPY.noSources}</p>
      ) : source.kind === 'unknown' ? (
        <p role="alert">{LIBRARY_COPY.unknownSource(source.sourceId)}</p>
      ) : source.kind === 'choose' ? (
        <>
          <p className="search-panel-note">{LIBRARY_COPY.chooseSource}</p>
          <label className="pattern-source">
            <span>{LIBRARY_COPY.sourceLabel}</span>
            <select defaultValue="" onChange={(event) => source.choose(event.target.value)}>
              <option value="" disabled>
                {LIBRARY_COPY.sourcePlaceholder}
              </option>
              {source.sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.alias}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <LibraryBody key={source.source.id} source={source.source} />
      )}
    </section>
  );
}
