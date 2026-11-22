import { createContext, useContext, useState, type ReactNode } from 'react';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import type { Viewport } from '../state/presentation-state.js';
import type { CanvasRenderer } from './scene.js';
import type { PictureCapture } from './masked-picture.js';
import type { SnapshotBounds } from './snapshot.js';

/** What the controls around the canvas can ask of it; absent while no renderer is running. */
export interface CanvasCommands {
  readonly fit: () => void;
  readonly zoomBy: (factor: number) => void;
  readonly layout: () => void;
  /** The viewport the canvas shows now. */
  readonly viewport: () => Viewport;
  /** Pans so an item is at the centre of the canvas; the zoom and every position stay. */
  readonly centerOn: (key: string) => void;
  /** Where an item is on the page; see `CanvasRenderer.anchorOf`. */
  readonly anchorOf: (key: string | undefined) => { readonly x: number; readonly y: number } | undefined;
  /** The drawn view as a PNG; see `CanvasRenderer.snapshot`. A failure rejects, and is the caller's to report, not the canvas's. */
  readonly snapshot: (bounds: SnapshotBounds) => Promise<Blob>;
  /** Holds the view as it is now, to draw a picture of it later from other items: what is drawn is the view of this moment, and the canvas on screen is not touched. */
  readonly capture: () => PictureCapture;
}

export interface CanvasCommandsHandle {
  readonly view: ReadableStore<CanvasCommands | undefined>;
  /** Makes the renderer's commands available and returns the function that withdraws them; a command that fails is reported to `onFailure` and not thrown. */
  attach(renderer: CanvasRenderer, onFailure: () => void, layout: () => void, capture?: CanvasCommands['capture']): () => void;
}

function createCanvasCommandsHandle(): CanvasCommandsHandle {
  const store = createStore<CanvasCommands | undefined>(undefined);
  return {
    view: readable(store),
    attach(renderer, onFailure, layout, capture = () => {
      throw new Error('no picture can be drawn apart');
    }) {
      const guarded = (command: () => void): void => {
        try {
          command();
        } catch {
          // the canvas shows its notice; the library's own message is not shown
          onFailure();
        }
      };
      const commands: CanvasCommands = { fit: () => guarded(() => renderer.fit()), zoomBy: (factor) => guarded(() => renderer.zoomBy(factor)), layout: () => guarded(layout), centerOn: (key) => guarded(() => renderer.centerOn(key)), viewport: () => renderer.viewport(), anchorOf: (key) => renderer.anchorOf(key), snapshot: (bounds) => renderer.snapshot(bounds), capture };
      store.setState(commands);
      return () => {
        if (store.getState() === commands) store.setState(undefined);
      };
    },
  };
}

const CanvasCommandsContext = createContext<CanvasCommandsHandle | undefined>(undefined);

export function CanvasCommandsProvider({ children }: { readonly children: ReactNode }) {
  const [handle] = useState(createCanvasCommandsHandle);
  return <CanvasCommandsContext.Provider value={handle}>{children}</CanvasCommandsContext.Provider>;
}

export function useCanvasCommandsHandle(): CanvasCommandsHandle {
  const handle = useContext(CanvasCommandsContext);
  if (handle === undefined) throw new Error('the canvas commands are not provided');
  return handle;
}

export function useCanvasCommands(): CanvasCommands | undefined {
  return useStoreSelector(useCanvasCommandsHandle().view, (commands) => commands);
}
