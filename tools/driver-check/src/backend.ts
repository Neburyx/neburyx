import type { LookResult } from './probe.js';

export interface Rows {
  readonly records: readonly { get(key: string): unknown }[];
}

export interface BeginOptions {
  readonly timeout: number;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface TxHandle {
  run(query: string): Promise<Rows>;
  commit(): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface SessionHandle {
  beginTransaction(options: BeginOptions): Promise<TxHandle>;
  run(query: string): Promise<Rows>;
  write(query: string, params: Readonly<Record<string, unknown>>): Promise<unknown>;
  close(): Promise<unknown>;
}

export interface Connection {
  session(mode: 'read' | 'write'): SessionHandle;
  /** One look at the transaction carrying `marker` in its metadata. */
  list(marker: string): Promise<LookResult>;
  close(): Promise<unknown>;
}

/** What the experiments need from a Neo4j client and server; the real one wraps `neo4j-driver`. */
export interface Backend {
  readonly driverVersion: string;
  connect(): Connection;
}
