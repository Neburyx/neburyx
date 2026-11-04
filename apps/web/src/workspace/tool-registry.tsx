import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import { createStore, readable, useStoreSelector, type ReadableStore } from '../state/store.js';

/** The order of the tools on the strip: a tool that ships later still lands in its place. */
export const TOOL_ORDER = { explore: 10, filters: 20, paths: 30, patterns: 40, search: 50, group: 60, table: 70 } as const;

export const EXPLORE_TOOL_ID = 'explore';

export interface FlyoutProps {
  /** Closes the flyout and puts the focus back on the tool's button. */
  readonly close: () => void;
}

export type ToolKind =
  | { readonly type: 'flyout'; readonly content: ComponentType<FlyoutProps> }
  /** The feature that registers the tool owns whatever it opens. */
  | { readonly type: 'action'; readonly activate: () => void };

export interface ToolEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: ReactNode;
  readonly order: number;
  readonly kind: ToolKind;
}

/** A tool as listed: the registration number is new each time a tool is registered, also for an ID registered before. */
export interface RegisteredTool extends ToolEntry {
  readonly registration: number;
}

export class ToolError extends Error {
  readonly code = 'TOOL_TAKEN';

  constructor(readonly toolId: string) {
    super(`TOOL_TAKEN: ${toolId}`);
    this.name = 'ToolError';
  }
}

export interface ToolRegistry {
  readonly view: ReadableStore<readonly RegisteredTool[]>;
  /** Adds a tool and returns the function that takes out that registration only. An ID already registered is refused. */
  register(entry: ToolEntry): () => void;
}

export function createToolRegistry(): ToolRegistry {
  const store = createStore<readonly RegisteredTool[]>([]);
  const registrations: Array<{ readonly token: symbol; readonly tool: RegisteredTool }> = [];
  let registered = 0;
  const publish = (): void => {
    const byOrder = registrations.map((registration, index) => ({ tool: registration.tool, index })).sort((a, b) => a.tool.order - b.tool.order || a.index - b.index);
    store.setState(byOrder.map(({ tool }) => tool));
  };
  return {
    view: readable(store),
    register(entry) {
      if (registrations.some((registration) => registration.tool.id === entry.id)) throw new ToolError(entry.id);
      const token = Symbol(entry.id);
      registered += 1;
      registrations.push({ token, tool: { ...entry, registration: registered } });
      publish();
      return () => {
        const at = registrations.findIndex((registration) => registration.token === token);
        if (at === -1) return;
        registrations.splice(at, 1);
        publish();
      };
    },
  };
}

const ToolsContext = createContext<ToolRegistry | undefined>(undefined);

export function ToolsProvider({ registry, children }: { readonly registry: ToolRegistry; readonly children: ReactNode }) {
  return <ToolsContext.Provider value={registry}>{children}</ToolsContext.Provider>;
}

export function useToolRegistry(): ToolRegistry {
  const registry = useContext(ToolsContext);
  if (registry === undefined) throw new Error('the tools are not provided');
  return registry;
}

export function useTools(): readonly RegisteredTool[] {
  return useStoreSelector(useToolRegistry().view, (tools) => tools);
}
