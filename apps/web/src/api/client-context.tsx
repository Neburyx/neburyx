import { createContext, useContext, type ReactNode } from 'react';
import type { ApiClient } from './client.js';

const ApiClientContext = createContext<ApiClient | undefined>(undefined);

export function ApiClientProvider({ client, children }: { readonly client: ApiClient; readonly children: ReactNode }) {
  return <ApiClientContext.Provider value={client}>{children}</ApiClientContext.Provider>;
}

export function useApiClient(): ApiClient {
  const client = useContext(ApiClientContext);
  if (client === undefined) throw new Error('the API client is not provided');
  return client;
}
