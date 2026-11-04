import { randomUUID } from 'node:crypto';
import { Neo4jContainer } from '@testcontainers/neo4j';
import { startWithRetry } from '@neburyx/test-containers';

export interface Server {
  readonly image: string;
  readonly boltUri: string;
  readonly user: string;
  readonly password: string;
  stop(): Promise<void>;
}

export type StartServer = (image: string) => Promise<Server>;

const STARTUP_LIMIT_MS = 240_000;

export const startContainer: StartServer = async (image) => {
  const password = randomUUID();
  const started = await startWithRetry((labels) => new Neo4jContainer(image).withPassword(password).withStartupTimeout(STARTUP_LIMIT_MS).withLabels(labels).start());
  return {
    image,
    boltUri: started.getBoltUri(),
    user: started.getUsername(),
    password,
    stop: async () => {
      await started.stop();
    },
  };
};
