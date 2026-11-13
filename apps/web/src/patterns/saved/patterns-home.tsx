import { useEffect, useMemo, useRef } from 'react';
import type { ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import { useProfile } from '../../canvas/profile-context.js';
import { SavedList as SavedListView, type RowActions } from './saved-list.js';
import type { RowActionState } from './use-row-actions.js';
import type { SavedList } from './use-saved-patterns.js';

type Preset = TemplateListResponse['presets'][number];

interface Props {
  readonly sourceName: string;
  readonly saved: SavedList;
  readonly rows: RowActionState;
  /** The built-in patterns of the source, once read. */
  readonly presets: Preset[] | undefined;
  /** Runs a saved pattern in the run view of the panel. */
  readonly onRun: (item: ListedPattern) => void;
  /** Opens a saved pattern in the builder. */
  readonly onChange: (item: ListedPattern) => void;
  /** Copies another person's shared pattern and opens the copy in the builder. */
  readonly onCopyAndChange: (item: ListedPattern) => void;
  readonly onNewPattern: () => void;
  readonly newRef: React.RefObject<HTMLButtonElement | null>;
  /** Opens the form of a built-in pattern. */
  readonly onRunPreset: (preset: Preset) => void;
}

/** The home of the Patterns panel: the one list of built-in, own and shared patterns. Run opens the run view of the panel. */
export function PatternsHome({ sourceName, saved, rows, presets, onRun, onChange, onCopyAndChange, onNewPattern, newRef, onRunPreset }: Props) {
  const profile = useProfile();
  const nameOf = useMemo(() => {
    const names = new Map((profile?.entityTypes ?? []).map((type) => [type.type, type.displayName]));
    return (type: string): string => names.get(type) ?? type;
  }, [profile]);

  const items = saved.state.phase === 'ready' ? saved.state.items : undefined;
  const rowCount = items?.length;
  const previousRows = useRef(rowCount);
  const heading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // a row that goes (a delete, a share taken back) takes the focus with it: the list is where it goes
    if (previousRows.current !== undefined && rowCount !== undefined && rowCount < previousRows.current && document.activeElement === document.body) heading.current?.querySelector<HTMLElement>('input')?.focus();
    previousRows.current = rowCount;
  }, [rowCount]);

  const actions: RowActions = {
    run: onRun,
    runPreset: onRunPreset,
    rename: (item) => rows.open('rename', item),
    copy: rows.copy,
    remove: (item) => rows.open('delete', item),
    share: (item) => rows.open('share', item),
    unshare: rows.unshare,
    change: onChange,
    copyAndChange: onCopyAndChange,
    newPattern: onNewPattern,
  };

  return (
    <div ref={heading}>
      <SavedListView list={saved} sourceName={sourceName} presets={presets} actions={actions} nameOf={nameOf} newRef={newRef} />
    </div>
  );
}
