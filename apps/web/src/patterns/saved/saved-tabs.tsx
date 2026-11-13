import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import type { ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { useRequest } from '../../api/use-request.js';
import { useProfile } from '../../canvas/profile-context.js';
import { answeredData, useShellData } from '../../shell/shell-data.js';
import { useClientState } from '../../state/context.js';
import { useStoreSelector } from '../../state/store.js';
import { SavedRunArea } from './saved-run-area.js';
import { createSavedRunStore } from './saved-run-store.js';
import { SAVED_COPY, TABS, type Tab } from './saved-copy.js';
import { SavedTabPanel, type RowActions } from './saved-list.js';
import { countText, tabOf } from './saved-model.js';
import type { RowActionState } from './use-row-actions.js';
import type { SavedList } from './use-saved-patterns.js';

type TemplateList = ReturnType<typeof useRequest<TemplateListResponse>>;

interface Props {
  readonly client: ApiClient;
  readonly sourceId: string;
  readonly sourceName: string;
  readonly mask: boolean;
  readonly close: () => void;
  /** What Escape does: the panel keeps one, and this component says which. */
  readonly escape: MutableRefObject<() => void>;
  readonly saved: SavedList;
  readonly rows: RowActionState;
  /** Opens a saved pattern in the builder. */
  readonly onChange?: (item: ListedPattern) => void;
  /** The Built-in tab: the panel's own list of presets, which writes what Escape does into the ref it is given. */
  readonly renderBuiltIn: (list: TemplateList, presetEscape: MutableRefObject<() => void>) => ReactNode;
}

const LABEL: Readonly<Record<Tab, string>> = { mine: SAVED_COPY.mine, shared: SAVED_COPY.shared, 'built-in': SAVED_COPY.builtIn };

/** The tab list of the Patterns panel: My patterns and Shared on this source, read a page at a time, and Built-in, the presets as they were. A saved run shows its answer under the saved tabs. */
export function SavedPatternsTabs({ client, sourceId, sourceName, mask, close, escape, saved, rows, onChange, renderBuiltIn }: Props) {
  const state = useClientState();
  const shell = useShellData();
  const profile = useProfile();
  const load = useCallback((signal: AbortSignal) => client.listTemplates(sourceId, signal), [client, sourceId]);
  const templates = useRequest(load);
  const presets = templates.state.phase === 'ready' || templates.state.phase === 'loading' ? templates.state.data?.presets : undefined;
  const [tab, setTab] = useState<Tab>('built-in');
  const presetEscape = useRef<() => void>(close);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const timeoutMs = answeredData(shell.sources)?.items.find((item) => item.id === sourceId)?.timeoutMs;

  const items = saved.state.phase === 'ready' ? saved.state.items : undefined;
  const store = useMemo(() => createSavedRunStore(client, mask), [client, mask]);
  useEffect(() => () => store.dispose(), [store]);
  const run = useStoreSelector(store, (view) => view);
  const [target, setTarget] = useState<ListedPattern | undefined>(undefined);
  useEffect(() => {
    // a pattern the person deleted takes its run with it; one that left the list another way keeps what the run showed
    if (rows.removed !== undefined && rows.removed === target?.id) {
      store.clear();
      setTarget(undefined);
    }
  }, [rows.removed, target, store]);
  const { reload, markRun } = saved;
  useEffect(() => {
    // an unavailable answer, or a pattern that is gone, means the list was out of date; the run's own view stays on screen while the list is read again
    if (run.unavailable !== undefined || run.failure?.code === 'NOT_FOUND') reload();
  }, [run.unavailable, run.failure, reload]);
  useEffect(() => {
    // a result moves the last run of the person's own pattern; the pages already read stay
    if (run.result !== undefined) markRun(run.result.ask.id);
  }, [run.result, markRun]);
  const rowCount = items?.length;
  const previousRows = useRef(rowCount);
  useEffect(() => {
    // a row that goes (a delete, a share taken back) takes the focus with it: the selected tab is where it goes
    if (previousRows.current !== undefined && rowCount !== undefined && rowCount < previousRows.current && document.activeElement === document.body) tabs.current[TABS.indexOf(tab)]?.focus();
    previousRows.current = rowCount;
  }, [rowCount, tab]);

  const actions: RowActions = {
    run: (item) => {
      if (target?.id !== item.id) store.clear();
      setTarget(item);
      if (!item.askForStartingEntity) store.run({ id: item.id, kind: item.kind });
    },
    rename: (item) => rows.open('rename', item),
    copy: rows.copy,
    remove: (item) => rows.open('delete', item),
    share: (item) => rows.open('share', item),
    unshare: rows.unshare,
    change: (item) => onChange?.(item),
  };

  escape.current = tab === 'built-in' ? () => presetEscape.current() : run.running ? store.cancel : close;

  const countOf = (which: Tab): string | undefined => {
    if (which === 'built-in') return presets === undefined ? undefined : String(presets.length);
    if (saved.state.phase !== 'ready') return undefined;
    return countText(saved.state.items.filter((item) => tabOf(item) === which).length, saved.state.nextCursor !== null);
  };

  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : (index + step + TABS.length) % TABS.length;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const target = TABS[next];
    if (target === undefined) return;
    setTab(target);
    tabs.current[next]?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label={SAVED_COPY.tabs} className="pattern-tabs">
        {TABS.map((which, index) => {
          const count = countOf(which);
          return (
            <button
              key={which}
              id={`pattern-tab-${which}`}
              ref={(element) => {
                tabs.current[index] = element;
              }}
              type="button"
              role="tab"
              aria-selected={tab === which}
              aria-controls={`pattern-tabpanel-${which}`}
              tabIndex={tab === which ? 0 : -1}
              className="pattern-tab"
              onClick={() => setTab(which)}
              onKeyDown={(event) => onKey(event, index)}
            >
              {count === undefined ? LABEL[which] : `${LABEL[which]} · ${count}`}
            </button>
          );
        })}
      </div>
      {TABS.map((which) => (
        <div key={which} id={`pattern-tabpanel-${which}`} role="tabpanel" aria-labelledby={`pattern-tab-${which}`} hidden={tab !== which}>
          {which === 'built-in' ? renderBuiltIn(templates, presetEscape) : <SavedTabPanel tab={which} list={saved} sourceName={sourceName} presets={presets} actions={actions} running={run.running} />}
        </div>
      ))}
      {tab !== 'built-in' && target !== undefined && tabOf(target) === tab ? <SavedRunArea client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} store={store} target={items?.find((item) => item.id === target.id) ?? target} presets={presets} profile={profile} timeoutMs={timeoutMs} /> : null}
    </>
  );
}
