import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { parseDefinition } from './definition.js';
import { LoadError, loadExport } from './load.js';
import { BATCH_SIZE, BATCH_TIMEOUT_MS, CONNECTION_TIMEOUT_MS } from './settings.js';
import { ENV, exportDirectory } from './testing/export-helpers.js';
import { miniDefinitionText, miniMapping } from './testing/fixture.js';
import { recordingDriver, serverError } from './testing/recording-driver.js';

async function failure(promise: Promise<unknown>): Promise<LoadError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected the load to fail');
}

describe('a load', () => {
  it('prepares the schema, then nodes, then relationships, and checks the counts', async () => {
    const { factory, recording } = recordingDriver();
    const report = await loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory });
    const cyphers = recording.statements.map((statement) => statement.cypher);
    const position = (needle: string) => cyphers.findIndex((cypher) => cypher.includes(needle));
    expect(position('CREATE CONSTRAINT')).toBeLessThan(position('CREATE (n:`Widget`)'));
    expect(position('CREATE (n:`Widget`)')).toBeLessThan(position('CREATE (n:`Gadget`)'));
    expect(position('CREATE (n:`Gadget`)')).toBeLessThan(position('CREATE (a)-[r:`HAS`]->(b)'));
    expect(position('CREATE (a)-[r:`HAS`]->(b)')).toBeLessThan(position('RETURN count(n) AS found'));
    expect(report.phases.map((phase) => phase.name)).toEqual(['validate', 'connect', 'reset', 'schema', 'nodes', 'relationships', 'verify']);
    expect(report.nodes).toEqual({ Widget: 50, Gadget: 20 });
  });

  it('puts the connection timeout and the batch timeout on the driver and on every transaction, and sends data only as parameters', async () => {
    const { factory, recording } = recordingDriver();
    await loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory });
    expect(recording.settings?.connectionTimeout).toBe(CONNECTION_TIMEOUT_MS);
    expect(new Set(recording.transactionTimeouts)).toEqual(new Set([BATCH_TIMEOUT_MS]));
    expect(recording.statements.every((statement) => !statement.cypher.includes('W0001') && !statement.cypher.includes('rec-'))).toBe(true);
  });

  it('loads in batches of the stated size', async () => {
    const document = parseDocument(miniDefinitionText);
    document.setIn(['entities', 'widget', 'count'], BATCH_SIZE * 2 + 7);
    const definition = parseDefinition(String(document), miniMapping);
    const directory = exportDirectory(1, miniMapping, definition);
    const { factory, recording } = recordingDriver();
    await loadExport({ directory, source: miniMapping, env: ENV, reset: false, createDriver: factory });
    const sizes = recording.statements.filter((statement) => statement.cypher.includes('CREATE (n:`Widget`)')).map((statement) => {
      const rows = statement.parameters?.['rows'];
      return Array.isArray(rows) ? rows.length : -1;
    });
    expect(sizes).toEqual([BATCH_SIZE, BATCH_SIZE, 7]);
  });

  it('loads the relationships in batches too, with a remainder, each batch in a transaction of its own', async () => {
    const document = parseDocument(miniDefinitionText);
    document.setIn(['entities', 'widget', 'count'], BATCH_SIZE * 2 + 7);
    const definition = parseDefinition(String(document), miniMapping);
    const directory = exportDirectory(1, miniMapping, definition);
    const { factory, recording } = recordingDriver();
    await loadExport({ directory, source: miniMapping, env: ENV, reset: false, createDriver: factory });
    const sizes = recording.statements
      .filter((statement) => statement.cypher.includes('CREATE (a)-[r:`HAS`]->(b)'))
      .map((statement) => {
        const rows = statement.parameters?.['rows'];
        return Array.isArray(rows) ? rows.length : -1;
      });
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(sizes.slice(0, -1).every((size) => size === BATCH_SIZE)).toBe(true);
    expect(sizes.at(-1)).toBeGreaterThan(0);
    expect(sizes.at(-1)).toBeLessThanOrEqual(BATCH_SIZE);
    expect(sizes.at(-1)).not.toBe(BATCH_SIZE);
    expect(recording.transactionTimeouts).toHaveLength(recording.statements.length);
    expect(recording.commits).toBe(recording.statements.length);
  });
});

describe('a load that goes wrong', () => {
  it('stops at a failing batch with the label, the batch and the server code, and no value, and closes everything', async () => {
    const { factory, recording } = recordingDriver({ failWhen: (cypher) => (cypher.includes('CREATE (n:`Gadget`)') ? serverError('Neo.ClientError.Schema.ConstraintValidationFailed', 'MARKER_VALUE W0001') : undefined) });
    const error = await failure(loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory }));
    expect(error.message).toBe('the load stopped while loading nodes (Gadget, batch 1): Neo.ClientError.Schema.ConstraintValidationFailed');
    expect(error.message).not.toContain('MARKER_VALUE');
    expect(recording.rollbacks).toBe(1);
    expect(recording.sessionsClosed).toBe(1);
    expect(recording.driversClosed).toBe(1);
  });

  it('reports a timed-out batch as such and does not say the statement was cancelled', async () => {
    const { factory } = recordingDriver({ failWhen: (cypher) => (cypher.includes('CREATE (a)-[r:`HAS`]') ? serverError('Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration') : undefined) });
    const error = await failure(loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory }));
    expect(error.message).toContain('TransactionTimedOutClientConfiguration');
    expect(error.message).not.toMatch(/cancel/i);
  });

  it('fails with the failure kind and no value when the address cannot be reached, and closes everything', async () => {
    const { factory, recording } = recordingDriver({ unreachable: serverError('ServiceUnavailable', 'could not reach bolt://MARKER_ADDRESS') });
    const error = await failure(loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory }));
    expect(error.message).toBe('the load stopped while connecting: ServiceUnavailable');
    expect(recording.driversClosed).toBe(1);
    expect(recording.sessionsClosed).toBe(1);
  });

  it('fails when the database counts differ from the manifest, naming the label and both counts', async () => {
    const { factory } = recordingDriver({ storedOffset: { Widget: 1 } });
    const error = await failure(loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory }));
    expect(error.message).toContain('Widget: found 51, expected 50');
  });

  it('fails when the relationship count differs, naming the type and both counts, and closes everything', async () => {
    const { factory, recording } = recordingDriver({ storedOffset: { HAS: -1 } });
    const error = await failure(loadExport({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false, createDriver: factory }));
    expect(error.message).toMatch(/HAS: found \d+, expected \d+/);
    expect(error.code).toBe('count-mismatch');
    expect(recording.sessionsClosed).toBe(1);
    expect(recording.driversClosed).toBe(1);
  });
});

describe('cleanup', () => {
  const MARKER = 'MARKER_DRIVER_MESSAGE';
  const base = () => ({ directory: exportDirectory(), source: miniMapping, env: ENV, reset: false });

  it('does not leak when the driver cannot be created', async () => {
    const error = await failure(loadExport({ ...base(), createDriver: () => { throw serverError('ServiceUnavailable', MARKER); } }));
    expect(error.message).toBe('the load stopped while connecting: ServiceUnavailable');
  });

  it('closes the driver when the session cannot be created', async () => {
    const { factory, recording } = recordingDriver();
    const error = await failure(loadExport({ ...base(), createDriver: (settings) => ({ ...factory(settings), session: () => { throw serverError('ProtocolError', MARKER); } }) }));
    expect(error.message).toBe('the load stopped while connecting: ProtocolError');
    expect(recording.driversClosed).toBe(1);
  });

  it('closes the driver when closing the session throws at once, and keeps the primary error', async () => {
    const { factory, recording } = recordingDriver({ failWhen: (cypher) => (cypher.includes('CREATE (n:`Gadget`)') ? serverError('Neo.ClientError.Schema.ConstraintValidationFailed') : undefined) });
    const error = await failure(
      loadExport({ ...base(), createDriver: (settings) => { const driver = factory(settings); return { ...driver, session: (config) => ({ ...driver.session(config), close: () => { throw new Error(MARKER); } }) }; } }),
    );
    expect(error.code).toBe('Neo.ClientError.Schema.ConstraintValidationFailed');
    expect(recording.driversClosed).toBe(1);
  });

  it('reports a failure to close after a load that otherwise worked, without the driver message', async () => {
    const { factory, recording } = recordingDriver();
    const error = await failure(loadExport({ ...base(), createDriver: (settings) => ({ ...factory(settings), close: () => Promise.reject(new Error(MARKER)) }) }));
    expect(error.message).toBe('the load stopped while cleaning up: close-failed');
    expect(recording.sessionsClosed).toBe(1);
  });
});
