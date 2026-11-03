import { AdapterError, type RendererAdapter } from '../adapter.js';
import { createCytoscapeAdapter } from './cytoscape.js';

export type AsyncAdapterFactory = (container: HTMLElement | undefined) => Promise<RendererAdapter>;

const factories = new Map<string, AsyncAdapterFactory>([
  ['cytoscape', async (container) => createCytoscapeAdapter({ container })],
  [
    'sigma',
    async (container) => {
      if (container === undefined) throw new AdapterError('ADAPTER_NEEDS_BROWSER');
      const { createSigmaAdapter } = await import('./sigma.js');
      return createSigmaAdapter({ container });
    },
  ],
]);

export function adapterNames(): readonly string[] {
  return [...factories.keys()];
}

export function registerAdapter(name: string, factory: AsyncAdapterFactory): void {
  if (factories.has(name)) throw new AdapterError('ADAPTER_EXISTS');
  factories.set(name, factory);
}

export async function createAdapter(name: string, container: HTMLElement | undefined): Promise<RendererAdapter> {
  const factory = factories.get(name);
  if (factory === undefined) throw new AdapterError('ADAPTER_UNKNOWN');
  return factory(container);
}
