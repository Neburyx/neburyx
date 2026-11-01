import { createRequire } from 'node:module';
import neo4j from 'neo4j-driver';
import type { Backend, Connection } from './backend.js';
import { listTransactions } from './listing.js';
import type { Server } from './server.js';

function driverVersionOf(): string {
  const pkg: unknown = createRequire(import.meta.url)('neo4j-driver/package.json');
  if (typeof pkg === 'object' && pkg !== null && 'version' in pkg && typeof pkg.version === 'string') return pkg.version;
  throw new Error('cannot read the neo4j-driver version');
}

export function neo4jBackend(server: Server): Backend {
  return {
    driverVersion: driverVersionOf(),
    connect(): Connection {
      const driver = neo4j.driver(server.boltUri, neo4j.auth.basic(server.user, server.password));
      return {
        session(mode) {
          const session = driver.session({ defaultAccessMode: mode === 'read' ? neo4j.session.READ : neo4j.session.WRITE });
          return {
            beginTransaction: async (options) => {
              const tx = await session.beginTransaction(options.metadata ? { timeout: options.timeout, metadata: { ...options.metadata } } : { timeout: options.timeout });
              return { run: async (query) => await tx.run(query), commit: () => tx.commit(), close: () => tx.close() };
            },
            run: async (query) => await session.run(query),
            write: (query, params) => session.executeWrite((tx) => tx.run(query, { ...params })),
            close: () => session.close(),
          };
        },
        list: (marker) => listTransactions(driver, marker),
        close: () => driver.close(),
      };
    },
  };
}
