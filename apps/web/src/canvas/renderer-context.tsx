import { createContext, useContext, type ReactNode } from 'react';
import type { CreateRenderer } from './scene.js';

const RendererContext = createContext<CreateRenderer | undefined>(undefined);

export function RendererProvider({ createRenderer, children }: { readonly createRenderer: CreateRenderer; readonly children: ReactNode }) {
  return <RendererContext.Provider value={createRenderer}>{children}</RendererContext.Provider>;
}

export function useCreateRenderer(): CreateRenderer {
  const create = useContext(RendererContext);
  if (create === undefined) throw new Error('the renderer is not provided');
  return create;
}
