import { useState, type ComponentType } from 'react';
import { Link } from 'react-router';
import { EXPLORE_PATH } from '../shell/navigation.js';
import type { SelectionAction, SelectionActionRegistry } from '../workspace/selection-actions.js';
import type { PanelEntry, PanelRegistry } from '../workspace/panel-registry.js';
import type { SlotName, SlotRegistry } from '../workspace/slots.js';
import { edgeKey } from '../state/keys.js';
import { KeyBindingError, type KeyBindingRegistry, type KeyGroup } from '../workspace/key-binding-registry.js';
import { MENU_GROUP, MENU_ORDER, type MenuContext, type MenuItem, type MenuItemState, type MenuRegistry, type MenuTargetKind } from '../workspace/menu-registry.js';
import { TOOL_ORDER, type ToolEntry, type ToolRegistry } from '../workspace/tool-registry.js';
import '../styles/stand-ins.css';

export const STAND_IN_MARKER = 'neburyx-dev-stand-ins';

const STAND_INS: readonly (readonly [SlotName, ComponentType])[] = [
  ['investigation-menu', () => <button type="button" className="stand-in-header-action" aria-label="Investigation menu">···</button>],
  ['views', () => <button type="button" className="stand-in-header-action">Views ▾</button>],
  ['export', () => <button type="button" className="stand-in-header-action">Export</button>],
  ['save', () => <button type="button" className="stand-in-header-action stand-in-save">Save</button>],
  ['table-toggle', () => <div className="stand-in stand-in-table" data-dev-tool={STAND_IN_MARKER}>Table</div>],
  ['zoom-controls', () => <div className="stand-in stand-in-zoom" data-dev-tool={STAND_IN_MARKER}>Zoom</div>],
  ['floating', () => null],
  [
    'search',
    () => (
      <Link to={EXPLORE_PATH} className="rail-stand-in" aria-label="Search">
        <span className="icon icon-search" aria-hidden="true" />
      </Link>
    ),
  ],
  [
    'settings',
    () => (
      <button type="button" className="rail-stand-in rail-stand-in-gear" aria-label="Settings">
        <span className="icon icon-settings" aria-hidden="true" />
      </button>
    ),
  ],
];

/** Puts a stand-in in every slot that is free, leaves occupied slots as they are, and returns the function that takes out what it put in. */
export function registerStandIns(registry: SlotRegistry): () => void {
  const removals = STAND_INS.filter(([slot]) => !registry.view.getState().has(slot)).map(([slot, occupant]) => registry.register(slot, occupant));
  return () => {
    for (const remove of removals) remove();
  };
}

const TEST_PANEL_ROWS = 40;

function testPanel(heading: string, text: string): ComponentType {
  return function TestPanel() {
    const [tall, setTall] = useState(false);
    return (
      <div className="stand-in-panel" data-dev-tool={STAND_IN_MARKER}>
        <p className="stand-in-panel-heading">{heading}</p>
        <p>{text}</p>
        <button type="button" aria-pressed={tall} onClick={() => setTall((current) => !current)}>
          Tall content
        </button>
        {tall ? Array.from({ length: TEST_PANEL_ROWS }, (_, row) => <p key={row}>Row {row + 1}</p>) : null}
      </div>
    );
  };
}

const FLOATING_TOP = 64;

export interface StandInPanelOptions {
  /** The side the floating test panel is on, or false for none. */
  readonly floating?: 'left' | 'right' | false;
  /** Whether the dock test panel is put in; it is, unless this is false. */
  readonly dock?: boolean;
}

/** Puts a test panel in the dock and one over the canvas, leaving a place or an ID that a panel already holds alone, and returns the function that takes out what it put in. */
export function registerStandInPanels(registry: PanelRegistry, options: StandInPanelOptions = {}): () => void {
  const { floating = 'right', dock = true } = options;
  const wanted: readonly PanelEntry[] = [
    ...(dock ? [{ id: 'dev-dock-test', title: 'Dock test panel', placement: { kind: 'dock' } as const, content: testPanel('Dock test panel', 'A panel in the dock, beside the canvas.') }] : []),
    ...(floating === false ? [] : [{ id: 'dev-floating-test', title: 'Floating test panel', placement: { kind: 'floating', side: floating, top: FLOATING_TOP } as const, content: testPanel('Floating test panel', 'A panel over the canvas.') }]),
  ];
  const taken = registry.view.getState();
  const removals = wanted.filter((panel) => !taken.some((other) => other.id === panel.id || (panel.placement.kind === 'dock' && other.placement.kind === 'dock'))).map((panel) => registry.register(panel));
  return () => {
    for (const remove of removals) remove();
  };
}

export interface FixtureControl {
  readonly label: string;
  readonly run: () => void;
}

/** Buttons on the canvas that stand in for what is not built yet (an expand that loads more entities, a drag that displaces some): they take the slot for floating panels, so they are registered before the other stand-ins and are taken out by the function this returns. */
export function registerFixtureControls(registry: SlotRegistry, controls: readonly FixtureControl[]): () => void {
  return registry.register('floating', () => (
    <div className="stand-in-fixture-controls" data-dev-tool={STAND_IN_MARKER}>
      {controls.map((control) => (
        <button key={control.label} type="button" className="stand-in-fixture-control" onClick={control.run}>
          {control.label}
        </button>
      ))}
    </div>
  ));
}

const icon = (name: string) => <span className={`icon icon-stand-in-${name}`} aria-hidden="true" />;

const STAND_IN_ACTIONS: readonly SelectionAction[] = [
  { id: 'stand-in-expand', label: 'Expand', icon: icon('expand'), run: () => undefined },
  { id: 'stand-in-paths', label: 'Paths between', icon: icon('paths'), run: () => undefined },
  { id: 'stand-in-group', label: 'Group', icon: icon('group'), run: () => undefined },
  { id: 'stand-in-pin', label: 'Pin', icon: icon('pin'), run: () => undefined },
  { id: 'stand-in-hide', label: 'Hide', icon: icon('hide'), run: () => undefined },
];

/** Puts a stand-in for each selection action that is not built yet, leaves the places that are taken, and returns the function that takes out what it put in. */
export function registerStandInActions(registry: SelectionActionRegistry): () => void {
  const taken = new Set(registry.view.getState().map((action) => action.id));
  const removals = STAND_IN_ACTIONS.filter((action) => !taken.has(action.id)).map((action) => registry.register(action));
  return () => {
    for (const remove of removals) remove();
  };
}

const toolIcon = (id: string) => <span className={`icon icon-stand-in-tool-${id}`} data-dev-tool={STAND_IN_MARKER} aria-hidden="true" />;

const STAND_IN_TOOLS: readonly ToolEntry[] = (['filters', 'paths', 'patterns', 'search', 'group', 'table'] as const).map((id) => ({
  id,
  label: `${id.charAt(0).toUpperCase()}${id.slice(1)}`,
  icon: toolIcon(id),
  order: TOOL_ORDER[id],
  kind: { type: 'action', activate: () => undefined },
}));

/** Puts a stand-in for each tool that is not built yet, leaves the places that are taken, and returns the function that takes out what it put in. */
export function registerStandInTools(registry: ToolRegistry): () => void {
  const taken = new Set(registry.view.getState().map((tool) => tool.id));
  const removals = STAND_IN_TOOLS.filter((tool) => !taken.has(tool.id)).map((tool) => registry.register(tool));
  return () => {
    for (const remove of removals) remove();
  };
}

const menuIcon = (name: string) => <span className={`icon icon-stand-in-menu-${name}`} data-dev-tool={STAND_IN_MARKER} aria-hidden="true" />;

function StandInSubmenu() {
  return (
    <div data-dev-tool={STAND_IN_MARKER}>
      <p className="menu-heading">Stand-in submenu</p>
      {['First choice', 'Second choice', 'Third choice'].map((label) => (
        <button key={label} type="button" className="menu-row">
          <span className="menu-label">{label}</span>
        </button>
      ))}
    </div>
  );
}

const nothing = (): void => undefined;
const typeOf = (context: MenuContext): string => context.state.loadedGraph().edges.find((edge) => edgeKey(edge.ref) === context.key)?.type ?? 'type';

interface CommandOptions {
  readonly binding?: string;
  readonly state?: MenuItemState;
}

const command = (id: string, label: MenuItem['label'], icon: string, group: number, order: number, options: CommandOptions = {}): MenuItem => {
  const { binding, state } = options;
  return { id, label, icon: menuIcon(icon), group, order, run: nothing, ...(binding === undefined ? {} : { binding }), ...(state === undefined ? {} : { state }) };
};
const parent = (id: string, label: string, icon: string, group: number, order: number): MenuItem => ({ id, label, icon: menuIcon(icon), group, order, submenu: StandInSubmenu });

const NODE_GROUP = MENU_GROUP.node;
const NODE_ORDER = MENU_ORDER.node;
const RELATIONSHIP_GROUP = MENU_GROUP.relationship;
const RELATIONSHIP_ORDER = MENU_ORDER.relationship;

const STAND_IN_MENU_ITEMS: readonly (readonly [MenuTargetKind, MenuItem])[] = [
  ['canvas', parent('stand-in-group-all', 'Group all by type', 'group', MENU_GROUP.canvas.grouping, MENU_ORDER.canvas.groupAll)],
  ['canvas', command('stand-in-ungroup-all', 'Ungroup all', 'ungroup', MENU_GROUP.canvas.grouping, MENU_ORDER.canvas.ungroupAll)],
  ['canvas', command('stand-in-export-view', 'Export view…', 'download', MENU_GROUP.canvas.export, MENU_ORDER.canvas.exportView, { binding: 'export-view' })],
  ['node', command('stand-in-expand-neighbors', 'Expand neighbors', 'expand', NODE_GROUP.expand, NODE_ORDER.expandNeighbors, { binding: 'expand' })],
  ['node', parent('stand-in-expand-by-type', 'Expand by type', 'types', NODE_GROUP.expand, NODE_ORDER.expandByType)],
  ['node', command('stand-in-focus', 'Focus neighborhood', 'focus', NODE_GROUP.expand, NODE_ORDER.focusNeighborhood, { binding: 'focus' })],
  ['node', command('stand-in-paths-from', 'Find paths from here…', 'route', NODE_GROUP.paths, NODE_ORDER.findPathsFromHere, { binding: 'find-paths' })],
  ['node', command('stand-in-paths-to', 'Find paths to…', 'route', NODE_GROUP.paths, NODE_ORDER.findPathsTo)],
  ['node', parent('stand-in-run-pattern', 'Run pattern', 'pattern', NODE_GROUP.paths, NODE_ORDER.runPattern)],
  ['node', command('stand-in-select-neighbors', 'Select neighbors', 'select', NODE_GROUP.selection, NODE_ORDER.selectNeighbors)],
  ['node', command('stand-in-invert', 'Invert selection', 'invert', NODE_GROUP.selection, NODE_ORDER.invertSelection, { binding: 'invert-selection' })],
  ['node', parent('stand-in-group-by-type', 'Group by type', 'group', NODE_GROUP.selection, NODE_ORDER.groupByType)],
  ['node', command('stand-in-pin', 'Pin position', 'pin', NODE_GROUP.selection, NODE_ORDER.pinPosition, { binding: 'pin' })],
  ['node', command('stand-in-hide', 'Hide from view', 'hide', NODE_GROUP.selection, NODE_ORDER.hideFromView, { binding: 'hide' })],
  ['node', command('stand-in-copy-id', 'Copy ID', 'copy', NODE_GROUP.copy, NODE_ORDER.copyId, { binding: 'copy-id' })],
  ['node', command('stand-in-copy-properties', 'Copy properties', 'copy', NODE_GROUP.copy, NODE_ORDER.copyProperties, { binding: 'copy-properties' })],
  ['node', command('stand-in-open-record', 'Open source record', 'external', NODE_GROUP.copy, NODE_ORDER.openSourceRecord)],
  ['relationship', command('stand-in-why', 'Why is this relationship here?', 'why', RELATIONSHIP_GROUP.explain, RELATIONSHIP_ORDER.explain)],
  ['relationship', command('stand-in-supporting', 'View supporting records', 'external', RELATIONSHIP_GROUP.explain, RELATIONSHIP_ORDER.viewSupportingRecords)],
  ['relationship', command('stand-in-highlight', 'Highlight endpoints', 'focus', RELATIONSHIP_GROUP.endpoints, RELATIONSHIP_ORDER.highlightEndpoints)],
  ['relationship', command('stand-in-select-endpoints', 'Select both endpoints', 'select', RELATIONSHIP_GROUP.endpoints, RELATIONSHIP_ORDER.selectBothEndpoints)],
  ['relationship', command('stand-in-paths-between', 'Find paths between endpoints', 'route', RELATIONSHIP_GROUP.endpoints, RELATIONSHIP_ORDER.findPathsBetween)],
  ['relationship', command('stand-in-hide-this', 'Hide this relationship', 'hide', RELATIONSHIP_GROUP.visibility, RELATIONSHIP_ORDER.hideThis, { binding: 'hide' })],
  ['relationship', command('stand-in-hide-all', (context) => `Hide all ${typeOf(context)}`, 'hide', RELATIONSHIP_GROUP.visibility, RELATIONSHIP_ORDER.hideAllOfType)],
  ['relationship', command('stand-in-show-only', (context) => `Show only ${typeOf(context)}`, 'show', RELATIONSHIP_GROUP.visibility, RELATIONSHIP_ORDER.showOnlyType)],
  ['relationship', command('stand-in-copy-relationship-id', 'Copy relationship ID', 'copy', RELATIONSHIP_GROUP.copy, RELATIONSHIP_ORDER.copyRelationshipId, { binding: 'copy-id' })],
  ['relationship', command('stand-in-copy-relationship-properties', 'Copy properties', 'copy', RELATIONSHIP_GROUP.copy, RELATIONSHIP_ORDER.copyProperties, { binding: 'copy-properties' })],
  ['relationship', command('stand-in-open-relationship-record', 'Open source record', 'external', RELATIONSHIP_GROUP.copy, RELATIONSHIP_ORDER.openSourceRecord, { state: 'disabled' })],
];

/** Puts a stand-in for each menu item that is not built yet, leaves the places that are taken, and returns the function that takes out what it put in. */
export function registerStandInMenuItems(registry: MenuRegistry): () => void {
  const taken = new Set([...registry.view.getState()].flatMap(([kind, items]) => items.map((item) => `${kind}/${item.id}`)));
  const removals = STAND_IN_MENU_ITEMS.filter(([kind, item]) => !taken.has(`${kind}/${item.id}`)).map(([kind, item]) => registry.register(kind, item));
  return () => {
    for (const remove of removals) remove();
  };
}

const STAND_IN_KEYS: readonly { readonly id: string; readonly keys: string; readonly label: string; readonly group: KeyGroup; readonly order: number }[] = [
  { id: 'search', keys: 'mod+k', label: 'Search', group: 'tools', order: 40 },
  { id: 'expand', keys: 'e', label: 'Expand', group: 'selection', order: 40 },
  { id: 'focus', keys: 'f', label: 'Focus', group: 'selection', order: 50 },
  { id: 'pin', keys: 'p', label: 'Pin position', group: 'actions', order: 10 },
  { id: 'hide', keys: 'delete', label: 'Hide', group: 'actions', order: 20 },
  { id: 'copy-id', keys: 'mod+c', label: 'Copy ID', group: 'actions', order: 30 },
  { id: 'find-paths', keys: 'shift+p', label: 'Find paths', group: 'actions', order: 40 },
  { id: 'export-view', keys: 'mod+e', label: 'Export view', group: 'actions', order: 50 },
  { id: 'copy-properties', keys: 'mod+shift+c', label: 'Copy properties', group: 'actions', order: 60 },
];

/** What the development pages do when a stand-in key is pressed: say which one on the page's root element, so a recorded browser run can see that the key reached it. */
export function markStandInKey(id: string): void {
  document.documentElement.dataset['lastStandInKey'] = id;
}

/** Puts a stand-in binding for each key the design shows that no feature has built yet; each runs `onRun` with its id, so that a test or a person can see that the key was bound. Returns the function that takes out what it put in. */
export function registerStandInKeyBindings(registry: KeyBindingRegistry, onRun: (id: string) => void = nothing): () => void {
  const removals = STAND_IN_KEYS.flatMap(({ id, keys, label, group, order }) => {
    try {
      return [registry.register({ id, keys: [keys], label, group, order, scope: 'workspace', run: () => onRun(id) })];
    } catch (error) {
      // a feature that has built the key by now keeps it
      if (error instanceof KeyBindingError) return [];
      throw error;
    }
  });
  return () => {
    for (const remove of removals) remove();
  };
}
