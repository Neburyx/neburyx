import { createContext, useContext, useState, type ReactNode } from 'react';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';
import type { CanvasRenderer } from './scene.js';

/** What the controls around the canvas can ask of it; absent while no renderer is running. */
export interface CanvasCommands {
  readonly fit: () => void;
  readonly zoomBy: (factor: number) => void;
  readonly layout: () => void;
}

export interface CanvasCommandsHandle {
  readonly view: ReadableStore<CanvasCommands | undefined>;
  /** Makes the renderer's commands available and returns the function that withdraws them; a command that fails is reported to `onFailure` and not thrown. */
  attach(renderer: CanvasRenderer, onFailure: () => void, layout: () => void): () => void;
}

export function createCanvasCommandsHandle(): CanvasCommandsHandle {
  const store = createStore<CanvasCommands | undefined>(undefined);
  return {
    view: readable(store),
    attach(renderer, onFailure, layout) {
      const guarded = (command: () => void): void => {
        try {
          command();
        } catch {
          // the canvas shows its notice; the library's own message is not shown
          onFailure();
        }
      };
      const commands: CanvasCommands = { fit: () => guarded(() => renderer.fit()), zoomBy: (factor) => guarded(() => renderer.zoomBy(factor)), layout: () => guarded(layout) };
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
