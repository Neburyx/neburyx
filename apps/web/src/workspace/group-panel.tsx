import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useProfile } from '../canvas/profile-context.js';
import { groupByComponent, groupAllByType, groupByProperty, ungroupAll, type Applied } from '../groups/group-actions.js';
import { BY_COMPONENT, BY_ENTITY_TYPE, eligibleProperties, groupName, panelList, propertyKeyOf, type PanelRow } from '../groups/group-model.js';
import { elementKey } from '../state/keys.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { GROUP_PANEL_COPY, groupsHeading, leftOutRelationship, leftOutValue, loadedText } from './group-copy.js';
import { focusGroupTool } from './group-tool.js';
import { legendGlyph } from './legend-panel.js';

type Mode = 'entityType' | 'property' | 'component';
const MODES: readonly { readonly mode: Mode; readonly label: string }[] = [
  { mode: 'entityType', label: GROUP_PANEL_COPY.entityType },
  { mode: 'property', label: GROUP_PANEL_COPY.property },
  { mode: 'component', label: GROUP_PANEL_COPY.component },
];

const modeOf = (by: string | undefined): Mode | undefined => (by === undefined ? undefined : by === BY_ENTITY_TYPE ? 'entityType' : by === BY_COMPONENT ? 'component' : propertyKeyOf(by) === undefined ? undefined : 'property');

function Row({ row, icon, onToggle, collapsed, label }: { readonly row: PanelRow; readonly icon: string | undefined; readonly onToggle: () => void; readonly collapsed: boolean; readonly label: string }) {
  return (
    <li className="group-row">
      <button type="button" className="group-row-chevron" aria-expanded={!collapsed} aria-label={label} onClick={onToggle}>
        <span className={collapsed ? 'icon icon-chevron-right' : 'icon icon-chevron-down'} aria-hidden="true" />
      </button>
      {icon === undefined ? null : <img className="group-row-glyph" src={legendGlyph(icon)} alt="" />}
      <span className="group-row-name">{row.name}</span>
      <span className="group-row-count">{loadedText(row.loaded)}</span>
    </li>
  );
}

/** The Group panel: how the loaded entities are grouped, the groups with their counts, and Ungroup all and Collapse all. */
export function GroupPanel() {
  const state = useClientState();
  const profile = useProfile();
  const graph = useLoadedGraph();
  const masking = useSessionMask();
  const groups = useStoreSelector(state.presentation.view, (current) => current.groups);
  const root = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Mode | undefined>(undefined);
  const [outcome, setOutcome] = useState<Applied | undefined>(undefined);
  const [showOther, setShowOther] = useState(false);
  const mode = picked ?? modeOf(groups[0]?.by);
  const nodes = useMemo(() => new Map(graph.nodes.map((node) => [elementKey(node.ref), node])), [graph]);
  const list = useMemo(() => panelList(groups, nodes, profile), [groups, nodes, profile]);
  const properties = eligibleProperties(profile, graph, masking);
  const chosenProperty = propertyKeyOf(groups[0]?.by ?? '');
  const nothingLoaded = graph.nodes.length === 0;
  const iconOf = (row: PanelRow): string | undefined => (row.group.by === BY_ENTITY_TYPE ? profile?.entityTypes.find((entry) => entry.type === nodes.get(row.group.members[0] ?? '')?.ref.entityType)?.icon : undefined);
  const close = (): void => {
    state.presentation.setGroupOpen(false);
    focusGroupTool();
  };
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[role="radio"]')?.focus();
  }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const choose = (next: Mode): void => {
    setPicked(next);
    setOutcome(undefined);
    if (next === 'entityType') setOutcome(groupAllByType(state));
    else if (next === 'component') setOutcome(groupByComponent(state));
  };
  const onRadioKey = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = MODES[(at + step + MODES.length) % MODES.length];
    if (next === undefined) return;
    choose(next.mode);
    root.current?.querySelectorAll<HTMLElement>('[role="radio"]')[(at + step + MODES.length) % MODES.length]?.focus();
  };
  const note =
    nothingLoaded
      ? undefined
      : outcome === undefined
        ? undefined
        : outcome.applied
          ? outcome.left > 0
            ? mode === 'component'
              ? leftOutRelationship(outcome.left)
              : mode === 'property'
                ? leftOutValue(outcome.left)
                : undefined
            : undefined
          : outcome.reason === 'no-group'
            ? mode === 'property'
              ? GROUP_PANEL_COPY.noPropertyValue
              : mode === 'component'
                ? GROUP_PANEL_COPY.noRelationships
                : undefined
            : undefined;
  return (
    <div className="group-panel" ref={root} onKeyDown={onKeyDown}>
      <button type="button" className="legend-close group-close" aria-label={GROUP_PANEL_COPY.close} onClick={close}>
        <span className="icon icon-clear" aria-hidden="true" />
      </button>
      <h2 className="search-panel-heading">{GROUP_PANEL_COPY.title}</h2>
      <p className="neighbor-types-note">{GROUP_PANEL_COPY.intro}</p>
      <div role="radiogroup" aria-label={GROUP_PANEL_COPY.groupBy} className="group-segments">
        <span className="supernode-label">{GROUP_PANEL_COPY.groupBy}</span>
        <div className="group-segment-row">
          {MODES.map(({ mode: option, label }, at) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={mode === option}
              tabIndex={mode === option || (mode === undefined && at === 0) ? 0 : -1}
              className="group-segment"
              disabled={nothingLoaded || (option === 'property' && properties === undefined)}
              onClick={() => choose(option)}
              onKeyDown={(event) => onRadioKey(event, at)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {mode === 'property' ? (
        properties === undefined ? (
          <p className="neighbor-types-note" role="status">
            {GROUP_PANEL_COPY.mappingLoading}
          </p>
        ) : (
          <div role="radiogroup" aria-label={GROUP_PANEL_COPY.propertyLabel} className="group-properties">
            {properties.map((key) => (
              <button key={key} type="button" role="radio" aria-checked={chosenProperty === key} className="group-property" onClick={() => setOutcome(groupByProperty(state, key, profile))}>
                {key}
              </button>
            ))}
          </div>
        )
      ) : null}
      <p className="group-heading" role="status">
        {groupsHeading(graph.nodes.length)}
      </p>
      {groups.length === 0 ? (
        <p className="neighbor-types-note" role="status">
          {nothingLoaded ? GROUP_PANEL_COPY.nothingLoaded : GROUP_PANEL_COPY.noGroups}
        </p>
      ) : (
        <ul className="group-rows">
          {list.rows.map((row) => (
            <Row key={row.group.id} row={row} icon={iconOf(row)} collapsed={row.group.collapsed} label={row.group.collapsed ? GROUP_PANEL_COPY.expandGroup(row.name) : GROUP_PANEL_COPY.collapseGroup(row.name)} onToggle={() => state.presentation.toggleGroup(row.group.id)} />
          ))}
          {list.other.length === 0 ? null : (
            <>
              <li className="group-row">
                <button type="button" className="group-row-chevron" aria-expanded={showOther} aria-label={showOther ? GROUP_PANEL_COPY.collapseOther : GROUP_PANEL_COPY.expandOther} onClick={() => setShowOther((held) => !held)}>
                  <span className={showOther ? 'icon icon-chevron-down' : 'icon icon-chevron-right'} aria-hidden="true" />
                </button>
                <span className="group-row-name">{GROUP_PANEL_COPY.otherTypes}</span>
                <span className="group-row-count">{loadedText(list.other.reduce((sum, row) => sum + row.loaded, 0))}</span>
              </li>
              {showOther
                ? list.other.map((row) => (
                    <Row key={row.group.id} row={row} icon={iconOf(row)} collapsed={row.group.collapsed} label={row.group.collapsed ? GROUP_PANEL_COPY.expandGroup(row.name) : GROUP_PANEL_COPY.collapseGroup(row.name)} onToggle={() => state.presentation.toggleGroup(row.group.id)} />
                  ))
                : null}
            </>
          )}
        </ul>
      )}
      {note === undefined ? null : (
        <p className="neighbor-types-note" role="status">
          {note}
        </p>
      )}
      <div className="group-actions">
        <button type="button" className="secondary" disabled={groups.length === 0} onClick={() => ungroupAll(state)}>
          {GROUP_PANEL_COPY.ungroupAll}
        </button>
        <button type="button" className="secondary" disabled={groups.length === 0} onClick={() => state.presentation.setGroupsCollapsed(true)}>
          {GROUP_PANEL_COPY.collapseAll}
        </button>
      </div>
      <p className="neighbor-types-note">{GROUP_PANEL_COPY.footnote}</p>
    </div>
  );
}
