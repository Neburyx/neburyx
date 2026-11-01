import { describe, expect, it } from 'vitest';
import { findings } from './fixtures.js';
import { describeQuick, inconclusiveFindings, NOT_TESTED, renderReport } from './report.js';

describe('report', () => {
  it('always lists what was not tested, including the read-only terminate check', () => {
    const text = renderReport([findings()]);
    expect(text).toContain('Not tested:');
    for (const line of NOT_TESTED) expect(text).toContain(line);
    expect(NOT_TESTED[0]).toContain('TERMINATE TRANSACTION');
  });

  it('names an inconclusive finding instead of calling it stopped', () => {
    const all = [findings({ neverSeen: true })];
    expect(inconclusiveFindings(all)).toEqual(['neo4j:test read timeout']);
    const text = renderReport(all);
    expect(text).toContain('finding: inconclusive');
    expect(text).toContain('Inconclusive findings: neo4j:test read timeout');
  });

  it('says there are none when every finding is established', () => {
    expect(renderReport([findings()])).toContain('Inconclusive findings: none');
  });

  it('reports a close that did not settle with the time it was called', () => {
    const text = renderReport([findings({ closeEnd: { kind: 'unsettled', calledAtMs: 2000 } })]);
    expect(text).toContain('the close: did not settle within 30000 ms (called at 2000 ms)');
  });

  it('reports a close that returned and a close that raised', () => {
    expect(renderReport([findings()])).toContain('the close: returned after 10 ms (called at 2000 ms)');
    const raised = renderReport([findings({ closeEnd: { kind: 'raised', calledAtMs: 2000, atMs: 22_000, errorClass: 'Neo4jError', code: 'Neo.X' } })]);
    expect(raised).toContain('the close: raised Neo4jError Neo.X after 20000 ms (called at 2000 ms)');
  });

  it('prints the versions, both timeout checkpoints and the timestamped samples', () => {
    const text = renderReport([findings()]);
    expect(text).toContain('Neo4j 0.0.0 community, neo4j-driver 0.0.0');
    expect(text).toContain('server state at the 20000 ms timeout:');
    expect(text).toContain('after the timeout (the server enforces it late):');
    expect(text).toContain('-500:running');
    expect(text).toContain('1000:absent');
  });

  it('lists cleanup problems', () => {
    const text = renderReport([findings({ cleanupFailures: ['session of the timeout run: did not finish within 5000 ms'] })]);
    expect(text).toContain('Cleanup problems:');
    expect(text).toContain('session of the timeout run: did not finish within 5000 ms');
  });
});

describe('container problems', () => {
  it('are listed in the report next to the findings', () => {
    const text = renderReport([findings()], ['the container of neo4j:test may still be running: still busy']);
    expect(text).toContain('Container cleanup problems:');
    expect(text).toContain('the container of neo4j:test may still be running: still busy');
  });
});

describe('describeQuick', () => {
  it('calls a read inside its timeout only when it finished within it', () => {
    expect(describeQuick({ returned: true, rows: 1, elapsedMs: 40 })).toBe('returned 1 row(s) after 40 ms, inside its timeout of 1000 ms');
    expect(describeQuick({ returned: true, rows: 1, elapsedMs: 1400 })).toContain('after 1400 ms, after its timeout of 1000 ms');
  });

  it('says so when it did not return', () => {
    expect(describeQuick({ returned: false, rows: 0, elapsedMs: 1100, what: 'Neo.X' })).toBe('did not return (Neo.X) after 1100 ms');
  });
});
