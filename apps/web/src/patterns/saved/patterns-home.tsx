import { useEffect, useMemo, useRef } from 'react';
import type { BuiltInDefinition, ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import type { ApiClient } from '../../api/client.js';
import { useProfile } from '../../canvas/profile-context.js';
import { SavedList as SavedListView, type RowActions } from './saved-list.js';
import type { RowActionState } from './use-row-actions.js';
import type { SavedList } from './use-saved-patterns.js';
import { observedAtOf, windowLabelOf } from '../form-model.js';

type Preset = TemplateListResponse['presets'][number];

interface Props {
  readonly sourceName: string;
  readonly saved: SavedList;
  readonly rows: RowActionState;
  /** The built-in patterns of the source, once read. */
  readonly presets: Preset[] | undefined;
  /** The built-in definitions of the source, and what the rows need to say their steps and to run or copy one. */
  readonly definitions?: readonly BuiltInDefinition[] | undefined;
  readonly words?: { readonly client: ApiClient; readonly sourceId: string; readonly mask: boolean; readonly onRunDefinition: (item: BuiltInDefinition) => void; readonly onCopyDefinition: (item: BuiltInDefinition) => void } | undefined;
  /** Runs a saved pattern in the run view of the panel. */
  readonly onRun: (item: ListedPattern) => void;
  /** Opens a saved pattern in the builder. */
  readonly onChange: (item: ListedPattern) => void;
  /** Copies another person's shared pattern and opens the copy in the builder. */
  readonly onCopyAndChange: (item: ListedPattern) => void;
  readonly onNewPattern: () => void;
  readonly newRef: React.RefObject<HTMLButtonElement | null>;
  /** Opens the form of a built-in pattern under its card, or closes it when its card is chosen again. */
  readonly onRunPreset: (preset: Preset) => void;
  /** The built-in pattern whose form is open under the cards, and that form with its result. */
  readonly selectedPresetId?: string | undefined;
  readonly presetPanel?: React.ReactNode;
}

/** The home of the Patterns panel: the one list of built-in, own and shared patterns. Run opens the run view of the panel. */
export function PatternsHome({ sourceName, saved, rows, presets, definitions, words, onRun, onChange, onCopyAndChange, onNewPattern, newRef, onRunPreset, selectedPresetId, presetPanel }: Props) {
  const profile = useProfile();
  const nameOf = useMemo(() => {
    const names = new Map((profile?.entityTypes ?? []).map((type) => [type.type, type.displayName]));
    return (type: string): string => names.get(type) ?? type;
  }, [profile]);

  const iconOf = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.icon ?? 'generic';
  const windowOf = (preset: Preset): string => windowLabelOf(preset, observedAtOf(profile, preset));

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
      <SavedListView list={saved} sourceName={sourceName} presets={presets} definitions={definitions} words={words === undefined ? undefined : { client: words.client, sourceId: words.sourceId, mask: words.mask, actions: { run: words.onRunDefinition, copy: words.onCopyDefinition } }} actions={actions} nameOf={nameOf} windowOf={windowOf} iconOf={iconOf} newRef={newRef} selectedPresetId={selectedPresetId} presetPanel={presetPanel} />
    </div>
  );
}
