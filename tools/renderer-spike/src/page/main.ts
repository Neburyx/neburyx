import { AdapterError, FIT_VIEW, type RendererAdapter } from '../adapter.js';
import { createAdapter } from '../adapters/registry.js';
import { FixtureError } from '../fixture/errors.js';
import { generateFixture } from '../fixture/generate.js';
import { createFocusModel, type FocusModel } from '../measure/focus-model.js';
import { measureIncremental } from '../measure/incremental.js';
import type { GroupingSnapshot, KeyboardState } from '../measure/probes.js';
import { measurePanZoom } from '../measure/pan-zoom.js';
import './handle.js';
import { attachKeyboard } from './keyboard.js';

const DEFAULT_ADAPTER = 'cytoscape';
const DEFAULT_SEED = 1;

function describeError(error: unknown): string {
  if (error instanceof AdapterError || error instanceof FixtureError) return error.code;
  return 'UNEXPECTED_ERROR';
}

const EMPTY_KEYBOARD_STATE: KeyboardState = { focusedId: null, ringVisible: false, activatedId: null, canvasFocused: false, announced: '' };

function start(): void {
  const status = document.getElementById('status');
  const canvas = document.getElementById('canvas');
  const live = document.getElementById('live');
  const params = new URLSearchParams(window.location.search);
  const adapterName = params.get('adapter') ?? DEFAULT_ADAPTER;
  const seed = Number(params.get('seed') ?? DEFAULT_SEED);
  if (status === null || canvas === null || live === null) return;
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', 'Graph');

  const fixture = generateFixture({ seed });
  let adapter: RendererAdapter | undefined;
  let focus: FocusModel | undefined;
  let activated: string | null = null;
  let listeners: AbortController | undefined;

  const requireAdapter = (): RendererAdapter => {
    if (adapter === undefined) throw new AdapterError('ADAPTER_NOT_MOUNTED');
    return adapter;
  };
  const show = (id: string | undefined): void => {
    requireAdapter().setFocus(id);
    live.textContent = id === undefined ? '' : (requireAdapter().describe().nodes.find((node) => node.id === id)?.label.replace('\n', ', ') ?? id);
  };
  const withFocus = (action: (model: FocusModel) => string): (() => void) => () => {
    if (focus !== undefined) show(action(focus));
  };
  const attach = (): void => {
    listeners = new AbortController();
    attachKeyboard(canvas, document, {
      beforeKey: () => {
        activated = null;
      },
      enter: withFocus((model) => model.enter()),
      leave: () => {
        if (adapter !== undefined) show(undefined);
      },
      next: withFocus((model) => model.next()),
      previous: withFocus((model) => model.previous()),
      first: withFocus((model) => model.first()),
      last: withFocus((model) => model.last()),
      activate: () => {
        activated = focus?.activate() ?? null;
      },
    }, listeners.signal);
  };
  const mount = async (): Promise<void> => {
    if (adapter !== undefined) throw new AdapterError('ADAPTER_ALREADY_MOUNTED');
    const created = await createAdapter(adapterName, canvas);
    created.mount(fixture);
    adapter = created;
    focus = createFocusModel(created.describe().nodes.map((node) => node.id));
    attach();
    status.textContent = `${adapterName} · seed ${seed} · mounted`;
  };
  const ready = mount();
  ready.catch((error: unknown) => {
    status.textContent = describeError(error);
  });

  window.__spike = {
    adapterName,
    ready: ready.catch((error: unknown) => {
      throw new Error(describeError(error));
    }),
    mount,
    dispose() {
      listeners?.abort();
      listeners = undefined;
      adapter?.dispose();
      adapter = undefined;
      focus = undefined;
      activated = null;
      live.textContent = '';
      status.textContent = `${adapterName} · disposed`;
    },
    describe: () => requireAdapter().describe(),
    async measurePanZoom(durationMs) {
      const current = requireAdapter();
      const timestamps = await measurePanZoom(current, durationMs, { nextFrame: (callback) => requestAnimationFrame(callback) });
      current.applyView(FIT_VIEW);
      return timestamps;
    },
    measureIncremental: () => measureIncremental(requireAdapter(), fixture, { now: () => performance.now(), nextFrame: (callback) => requestAnimationFrame(callback) }),
    groupingSnapshot: () => snapshot(requireAdapter(), true),
    group(typeId) {
      const current = requireAdapter();
      try {
        current.groupByType(typeId);
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'ADAPTER_UNSUPPORTED') return snapshot(current, false);
        throw error;
      }
      return snapshot(current, true);
    },
    ungroup(typeId) {
      const current = requireAdapter();
      try {
        current.ungroupByType(typeId);
      } catch (error) {
        if (error instanceof AdapterError && error.code === 'ADAPTER_UNSUPPORTED') return snapshot(current, false);
        throw error;
      }
      return snapshot(current, true);
    },
    keyboardState: (): KeyboardState => {
      if (adapter === undefined) return EMPTY_KEYBOARD_STATE;
      const id = focus?.current() ?? null;
      const focused = document.activeElement === canvas;
      return { focusedId: focused ? id : null, ringVisible: focused && id !== null && adapter.isFocusRingVisible(id), activatedId: activated, canvasFocused: focused, announced: live.textContent ?? '' };
    },
  };
}

function snapshot(adapter: RendererAdapter, supported: boolean): GroupingSnapshot {
  return { supported, nodesDrawn: adapter.describe().nodes.length, groups: adapter.groups() };
}

start();
