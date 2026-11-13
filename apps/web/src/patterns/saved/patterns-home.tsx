import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import type { ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { useProfile } from '../../canvas/profile-context.js';
import { answeredData, useShellData } from '../../shell/shell-data.js';
import { useStoreSelector } from '../../state/store.js';
import { SavedRunArea } from './saved-run-area.js';
import { createSavedRunStore } from './saved-run-store.js';
import { SavedList as SavedListView, type RowActions } from './saved-list.js';
import type { RowActionState } from './use-row-actions.js';
import type { SavedList } from './use-saved-patterns.js';

type Preset = TemplateListResponse['presets'][number];

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
  /** The built-in patterns of the source, once read. */
  readonly presets: Preset[] | undefined;
  /** Opens a saved pattern in the builder. */
  readonly onChange?: (item: ListedPattern) => void;
  /** Opens the form of a built-in pattern. */
  readonly onRunPreset: (preset: Preset) => void;
}

/** The home of the Patterns panel: the one list of built-in, own and shared patterns. A saved run shows its answer under the list. */
export function PatternsHome({ client, sourceId, sourceName, mask, close, escape, saved, rows, presets, onChange, onRunPreset }: Props) {
  const shell = useShellData();
  const profile = useProfile();
  const timeoutMs = answeredData(shell.sources)?.items.find((item) => item.id === sourceId)?.timeoutMs;
  const nameOf = useMemo(() => {
    const names = new Map((profile?.entityTypes ?? []).map((type) => [type.type, type.displayName]));
    return (type: string): string => names.get(type) ?? type;
  }, [profile]);

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
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // a row that goes (a delete, a share taken back) takes the focus with it: the list is where it goes
    if (previousRows.current !== undefined && rowCount !== undefined && rowCount < previousRows.current && document.activeElement === document.body) heading.current?.querySelector<HTMLElement>('input')?.focus();
    previousRows.current = rowCount;
  }, [rowCount]);

  const actions: RowActions = {
    run: (item) => {
      if (target?.id !== item.id) store.clear();
      setTarget(item);
      if (!item.askForStartingEntity) store.run({ id: item.id, kind: item.kind });
    },
    runPreset: onRunPreset,
    rename: (item) => rows.open('rename', item),
    copy: rows.copy,
    remove: (item) => rows.open('delete', item),
    share: (item) => rows.open('share', item),
    unshare: rows.unshare,
    change: (item) => onChange?.(item),
  };

  escape.current = run.running ? store.cancel : close;

  return (
    <div ref={heading}>
      <SavedListView list={saved} sourceName={sourceName} presets={presets} actions={actions} running={run.running} nameOf={nameOf} />
      {target !== undefined ? <SavedRunArea client={client} sourceId={sourceId} sourceName={sourceName} mask={mask} store={store} target={items?.find((item) => item.id === target.id) ?? target} presets={presets} profile={profile} timeoutMs={timeoutMs} /> : null}
    </div>
  );
}
