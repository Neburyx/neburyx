import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ListedPattern, TemplateListResponse } from '@neburyx/contracts';
import { failureView } from '../copy.js';
import { EmptyMine, ListUnreadable, ReasonSentences } from '../run/state-views.js';
import type { ApiFailure } from '../../api/client.js';
import { presetSummary, rowMatches, savedSummary } from './list-model.js';
import { RowMenu, type MenuEntry } from './row-menu.js';
import { SAVED_COPY } from './saved-copy.js';
import { controlsOf, countText, kindLineOf, lastRunText } from './saved-model.js';
import type { SavedList } from './use-saved-patterns.js';

type Preset = TemplateListResponse['presets'][number];

export interface RowActions {
  readonly run: (item: ListedPattern) => void;
  readonly runPreset: (preset: Preset) => void;
  readonly rename: (item: ListedPattern) => void;
  readonly copy: (item: ListedPattern) => void;
  readonly remove: (item: ListedPattern) => void;
  readonly share: (item: ListedPattern) => void;
  readonly unshare: (item: ListedPattern) => void;
  readonly change: (item: ListedPattern) => void;
  readonly copyAndChange: (item: ListedPattern) => void;
  /** + New pattern, from the empty state of My patterns. */
  readonly newPattern: () => void;
}

/** Whether the list has no pattern of the person's own: the empty state shows, and it carries + New pattern. */
export const ownIsEmpty = (list: SavedList): boolean => list.state.phase === 'ready' && list.state.nextCursor === null && !list.state.items.some((item) => item.ownedByYou);

interface Props {
  readonly list: SavedList;
  readonly sourceName: string;
  /** The built-in patterns of the source, once read. */
  readonly presets: readonly Preset[] | undefined;
  readonly actions: RowActions;
  /** The display name of an entity type. */
  readonly nameOf: (type: string) => string;
  readonly newRef?: React.RefObject<HTMLButtonElement | null>;
}

/**
 * The one list of the Patterns panel: a search, and three sections: the built-in patterns, the person's own and those shared on the source, each with its count and its rows, then the footnote. The search is on the client and covers the rows
 * read so far; a section whose list has more pages says so and keeps Load more.
 */
export function SavedList({ list, sourceName, presets, actions, nameOf, newRef }: Props) {
  const [text, setText] = useState('');
  const searchId = useId();
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Escape in the search clears the text first; the panel's own Escape, on its frame, is reached only when the box is empty
    const box = search.current;
    if (box === null || text === '') return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setText('');
    };
    box.addEventListener('keydown', onKey);
    return () => box.removeEventListener('keydown', onKey);
  }, [text]);
  const state = list.state;
  const items = state.phase === 'ready' ? state.items : undefined;
  const more = state.phase === 'ready' && state.nextCursor !== null;
  const mine = useMemo(() => (items ?? []).filter((item) => item.ownedByYou), [items]);
  const shared = useMemo(() => (items ?? []).filter((item) => !item.ownedByYou), [items]);
  const searching = text.trim() !== '';
  const builtIn = useRef<HTMLHeadingElement>(null);
  return (
    <div className="pattern-list">
      <input id={searchId} ref={search} type="search" className="pattern-search" aria-label={SAVED_COPY.searchLabel} placeholder={SAVED_COPY.searchLabel} value={text} onChange={(event) => setText(event.target.value)} />
      {searching && more ? (
        <p className="search-panel-note" role="status">
          {SAVED_COPY.searchLoadedOnly}
        </p>
      ) : null}
      <Section id="built-in" label={SAVED_COPY.builtIn} count={presets === undefined ? undefined : String(presets.length)} headingRef={builtIn}>
        {presets === undefined ? null : <BuiltInRows presets={presets} text={text} actions={actions} nameOf={nameOf} />}
      </Section>
      {state.phase === 'failed' ? (
        <ListUnreadable failure={state.failure} sourceName={sourceName} retry={list.reload} />
      ) : state.phase === 'loading' ? (
        <p className="search-panel-note" role="status">
          {SAVED_COPY.loading}
        </p>
      ) : (
        <>
          {state.cursorReset ? (
            <p className="search-panel-note" role="status">
              {SAVED_COPY.cursorReset}
            </p>
          ) : null}
          <Section id="mine" label={SAVED_COPY.mine} count={countText(mine.length, more)}>
            {mine.length === 0 && !more ? <EmptyMine newRef={newRef} onNew={actions.newPattern} onSeeBuiltIn={() => builtIn.current?.focus()} /> : <SavedRows items={mine} empty={SAVED_COPY.emptyMine} text={text} presets={presets} actions={actions} nameOf={nameOf} />}
          </Section>
          <Section id="shared" label={SAVED_COPY.shared} count={countText(shared.length, more)}>
            <SavedRows items={shared} empty={SAVED_COPY.emptyShared} text={text} presets={presets} actions={actions} nameOf={nameOf} />
          </Section>
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
        </>
      )}
      <p className="search-panel-note">{SAVED_COPY.footnote}</p>
    </div>
  );
}

function Section({ id, label, count, headingRef, children }: { readonly id: string; readonly label: string; readonly count: string | undefined; readonly headingRef?: React.RefObject<HTMLHeadingElement | null>; readonly children: React.ReactNode }) {
  const heading = `pattern-section-${id}`;
  return (
    <section className="pattern-section" aria-labelledby={heading}>
      <h3 className="pattern-section-heading" id={heading} tabIndex={headingRef === undefined ? undefined : -1} ref={headingRef}>
        {count === undefined ? label : `${label} · ${count}`}
      </h3>
      {children}
    </section>
  );
}

function BuiltInRows({ presets, text, actions, nameOf }: { readonly presets: readonly Preset[]; readonly text: string; readonly actions: RowActions; readonly nameOf: Props['nameOf'] }) {
  if (presets.length === 0) return <p className="search-panel-note">{SAVED_COPY.noBuiltIn}</p>;
  const rows = presets.map((preset) => ({ preset, summary: presetSummary(preset, nameOf) })).filter((row) => rowMatches(text, row.preset.name, row.summary));
  if (rows.length === 0) return <p className="search-panel-note">{SAVED_COPY.noneInSection}</p>;
  return (
    <ul className="pattern-rows">
      {rows.map(({ preset, summary }) => (
        <li key={preset.id} className="pattern-row">
          <div className="pattern-row-head">
            <h4 className="pattern-row-name">{preset.name}</h4>
          </div>
          {summary === '' ? null : <p className="search-panel-note">{summary}</p>}
          <div className="patterns-actions">
            <button type="button" className="primary" aria-label={`${SAVED_COPY.run} ${preset.name}`} onClick={() => actions.runPreset(preset)}>
              {SAVED_COPY.run}
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}

function SavedRows({ items, empty, text, presets, actions, nameOf }: { readonly items: readonly ListedPattern[]; readonly empty: string; readonly text: string; readonly presets: Props['presets']; readonly actions: RowActions; readonly nameOf: Props['nameOf'] }) {
  if (items.length === 0) return <p className="search-panel-note">{empty}</p>;
  const rows = items.map((item) => ({ item, summary: savedSummary(item, presets, nameOf) })).filter((row) => rowMatches(text, row.item.name, row.summary));
  if (rows.length === 0) return <p className="search-panel-note">{SAVED_COPY.noneInSection}</p>;
  return (
    <ul className="pattern-rows">
      {rows.map(({ item, summary }) => (
        <SavedRow key={item.id} item={item} summary={summary} kindName={item.kind === 'preset-run' ? kindLineOf(item, presets) : undefined} actions={actions} />
      ))}
    </ul>
  );
}

/** The menu of a row: the person's own pattern offers what the person may do, in the order of the frame; another person's shared pattern offers Run and Copy, and says what only its owner can do. */
function menuOf(item: ListedPattern, actions: RowActions): MenuEntry[] {
  const controls = controlsOf(item);
  if (!item.ownedByYou) {
    return [
      ...(controls.run ? [{ key: 'run', label: SAVED_COPY.run, onChoose: () => actions.run(item) }] : []),
      { key: 'copy', label: SAVED_COPY.copy, onChoose: () => actions.copy(item) },
      { key: 'owner-note', note: SAVED_COPY.ownedBy(item.owner.name) },
      { key: 'change', label: SAVED_COPY.change, onChoose: () => undefined, inert: SAVED_COPY.ownerOnly },
      { key: 'rename', label: SAVED_COPY.rename, onChoose: () => undefined, inert: SAVED_COPY.ownerOnly },
      { key: 'delete', label: SAVED_COPY.delete, onChoose: () => undefined, inert: SAVED_COPY.ownerOnly },
    ];
  }
  return [
    ...(controls.run ? [{ key: 'run', label: SAVED_COPY.run, onChoose: () => actions.run(item) }] : []),
    ...(controls.change ? [{ key: 'change', label: SAVED_COPY.change, onChoose: () => actions.change(item) }] : []),
    ...(controls.rename ? [{ key: 'rename', label: SAVED_COPY.rename, onChoose: () => actions.rename(item) }] : []),
    ...(controls.share ? [{ key: 'share', label: SAVED_COPY.share, onChoose: () => actions.share(item) }] : []),
    ...(controls.unshare ? [{ key: 'unshare', label: SAVED_COPY.unshare, onChoose: () => actions.unshare(item) }] : []),
    ...(controls.copy ? [{ key: 'copy', label: SAVED_COPY.copy, onChoose: () => actions.copy(item) }] : []),
    ...(controls.delete ? [{ key: 'delete', label: SAVED_COPY.delete, onChoose: () => actions.remove(item), danger: true }] : []),
  ];
}

function SavedRow({ item, summary, kindName, actions }: { readonly item: ListedPattern; readonly summary: string; readonly kindName: string | undefined; readonly actions: RowActions }) {
  const controls = controlsOf(item);
  const reasons = item.availability.status === 'unavailable' ? item.availability.reasons : [];
  const reasonId = `pattern-row-${item.id}-reason`;
  return (
    <li className="pattern-row">
      <div className="pattern-row-head">
        <h4 className="pattern-row-name">{item.name}</h4>
        <span className="pattern-row-badge">{item.visibility === 'shared' ? SAVED_COPY.sharedBadge : SAVED_COPY.privateBadge}</span>
        {item.availability.status === 'unavailable' ? <span className="pattern-row-flag">{SAVED_COPY.unavailable}</span> : null}
      </div>
      <p className="search-panel-note">
        {[kindName === undefined ? undefined : kindName, summary === '' ? undefined : summary, lastRunText(item), item.ownedByYou ? undefined : SAVED_COPY.sharedBy(item.owner.name)].filter((part): part is string => part !== undefined).join(' · ')}
      </p>
      {reasons.length === 0 ? null : (
        <div className="pattern-row-reasons" id={reasonId}>
          <ReasonSentences reasons={reasons} />
        </div>
      )}
      <div className="patterns-actions">
        <button type="button" className="primary" disabled={!controls.run} aria-label={`${SAVED_COPY.run} ${item.name}`} aria-describedby={controls.run ? undefined : reasonId} onClick={() => actions.run(item)}>
          {SAVED_COPY.run}
        </button>
        {reasons.length === 0 || item.kind !== 'definition' ? null : item.ownedByYou ? (
          <button type="button" className="secondary" onClick={() => actions.change(item)}>
            {SAVED_COPY.changePattern}
          </button>
        ) : (
          <button type="button" className="secondary" onClick={() => actions.copyAndChange(item)}>
            {SAVED_COPY.copyAndChange}
          </button>
        )}
        <RowMenu name={item.name} items={menuOf(item, actions)} />
      </div>
    </li>
  );
}
