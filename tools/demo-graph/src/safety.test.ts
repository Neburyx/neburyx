import { describe, expect, it } from 'vitest';
import { loadExport } from './load.js';
import { SafetyError, isDemoAddress } from './safety.js';
import { ENV, exportDirectory } from './testing/export-helpers.js';
import { miniMapping } from './testing/fixture.js';
import { recordingDriver } from './testing/recording-driver.js';

describe('which addresses count as a demo address', () => {
  it.each(['bolt://localhost:7687', 'neo4j://127.0.0.1:7687', 'bolt://[::1]:7687', 'bolt://demo-graph:7687', 'bolt://mini-graph', 'bolt://LOCALHOST'])('accepts %s', (address) => {
    expect(isDemoAddress(address)).toBe(true);
  });

  it.each([
    'bolt://db.example.test:7687',
    'neo4j+s://graph.internal:7687',
    'bolt://10.1.2.3:7687',
    'bolt://192.168.0.5:7687',
    'bolt://[2001:db8::1]:7687',
    'bolt://12345:7687',
    'bolt://user:pass@localhost:7687',
    'not an address',
    '',
  ])('refuses %s', (address) => {
    expect(isDemoAddress(address)).toBe(false);
  });
});

async function reason(options: { source?: typeof miniMapping; override?: string; env?: Record<string, string | undefined>; reset?: boolean; existingNodes?: number }): Promise<{ reason: string; connections: number; statements: number }> {
  const directory = exportDirectory();
  const { factory, recording } = recordingDriver(options.existingNodes === undefined ? {} : { existingNodes: options.existingNodes });
  try {
    await loadExport({ directory, source: options.source ?? miniMapping, override: options.override, env: options.env ?? ENV, reset: options.reset ?? false, createDriver: factory });
  } catch (error) {
    if (error instanceof SafetyError) return { reason: error.reason, connections: recording.drivers, statements: recording.statements.length };
    throw error;
  }
  throw new Error('expected a refusal');
}

describe('the loader refuses before it connects', () => {
  it.each([false, true])('a source that is not marked synthetic (reset: %s)', async (reset) => {
    expect(await reason({ source: { ...miniMapping, synthetic: false }, reset })).toEqual({ reason: 'source-not-synthetic', connections: 0, statements: 0 });
  });

  it.each([false, true])('an address in the mapping that is not a demo address, even with a safe override (reset: %s)', async (reset) => {
    expect(await reason({ source: { ...miniMapping, uri: 'bolt://db.example.test:7687' }, override: 'bolt://localhost:7687', reset })).toEqual({ reason: 'mapping-address', connections: 0, statements: 0 });
  });

  it.each([false, true])('an override that is not a demo address, even with a safe mapping address (reset: %s)', async (reset) => {
    expect(await reason({ override: 'bolt://db.example.test:7687', reset })).toEqual({ reason: 'override-address', connections: 0, statements: 0 });
  });

  it('an override that is not a demo address names the source', async () => {
    const directory = exportDirectory();
    const { factory } = recordingDriver();
    await expect(loadExport({ directory, source: miniMapping, override: 'bolt://db.example.test:7687', env: ENV, reset: false, createDriver: factory })).rejects.toThrow('mini-demo');
  });

  it('missing credential variables, naming the variables and the source and no value', async () => {
    const directory = exportDirectory();
    const { factory, recording } = recordingDriver();
    const attempt = loadExport({ directory, source: miniMapping, env: { MINI_USER: 'someone' }, reset: false, createDriver: factory });
    await expect(attempt).rejects.toThrow('the credential variables MINI_PASSWORD for mini-demo are not set');
    await expect(attempt).rejects.not.toThrow('someone');
    expect(recording.drivers).toBe(0);
  });
});

describe('the loader refuses a database that already holds nodes', () => {
  it('without the reset flag it writes nothing, schema included', async () => {
    const result = await reason({ existingNodes: 5 });
    expect(result.reason).toBe('database-not-empty');
    expect(result.connections).toBe(1);
  });

  it('writes no statement but the check itself', async () => {
    const directory = exportDirectory();
    const { factory, recording } = recordingDriver({ existingNodes: 5 });
    await expect(loadExport({ directory, source: miniMapping, env: ENV, reset: false, createDriver: factory })).rejects.toThrow(SafetyError);
    expect(recording.statements.map((statement) => statement.cypher)).toEqual(['MATCH (n) RETURN count(n) AS nodes']);
    expect(recording.sessionsClosed).toBe(1);
    expect(recording.driversClosed).toBe(1);
  });

  it('with the reset flag it clears the database first and then loads', async () => {
    const directory = exportDirectory();
    const { factory, recording } = recordingDriver({ existingNodes: 5 });
    await loadExport({ directory, source: miniMapping, env: ENV, reset: true, createDriver: factory });
    const cyphers = recording.statements.map((statement) => statement.cypher);
    expect(cyphers.findIndex((cypher) => cypher.includes('DETACH DELETE'))).toBeGreaterThan(0);
    expect(cyphers.findIndex((cypher) => cypher.includes('DETACH DELETE'))).toBeLessThan(cyphers.findIndex((cypher) => cypher.startsWith('CREATE CONSTRAINT')));
  });
});
