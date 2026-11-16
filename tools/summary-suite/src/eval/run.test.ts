import { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { loadCases } from '../cases.js';
import { cli } from '../testing/harness.js';

const set = loadCases();

describe('the stub run', () => {
  it('summarizes every view with the real summarizer, finds every fact the labelled sentences state, makes no claim, and exits 0', async () => {
    const result = await cli(['--stub']);
    expect(result.code).toBe(0);
    for (const view of set.cases) expect(result.text, view.id).toContain(`${view.id} [${view.source_case === undefined ? 'aml' : 'demo'}]: ok`);
    const expected = set.cases.reduce((total, each) => total + each.facts.length, 0);
    expect(result.text).toContain(`facts ${expected}/${expected}`);
    expect(result.text).toContain('claims made 0');
    expect(result.text).toContain('views run 17, not run 0');
  });

  it('opens no socket, and a key variable naming a file that cannot be read does not fail it, so no key is read', async () => {
    const opened = vi.spyOn(Socket.prototype, 'connect');
    const result = await cli(['--stub', '--views', 'aml-cycle'], { NEBURYX_ASK_API_KEY_FILE: '/nonexistent/key' });
    expect(result.code).toBe(0);
    expect(result.text).toContain('aml-cycle [aml]: ok');
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
  });

  it('reads no key and uses no network: it needs no environment, and a key variable is not read', async () => {
    const result = await cli(['--stub'], { NEBURYX_ASK_API_KEY: 'SENTINEL-KEY-VALUE', NEBURYX_ASK_API_KEY_FILE: '/nonexistent/key' });
    expect(result.code).toBe(0);
    expect(result.text + result.err.join('\n')).not.toContain('SENTINEL-KEY-VALUE');
  });

  it('covers only the views asked for: the demo views, the AML views, or the ids named, and refuses a name that is not a view', async () => {
    expect((await cli(['--stub', '--views', 'aml'])).text).toContain('views run 7, not run 0');
    expect((await cli(['--stub', '--views', 'demo'])).text).toContain('views run 10, not run 0');
    expect((await cli(['--stub', '--views', 'aml-cycle,aml-fan-in'])).text).toContain('views run 2, not run 0');
    const refused = await cli(['--stub', '--views', 'no-such-view']);
    expect(refused.code).toBe(2);
    expect(refused.err.join('\n')).toContain('no-such-view');
  });

  it('prints JSON with --json', async () => {
    const result = await cli(['--stub', '--json', '--views', 'aml-cycle']);
    const report = JSON.parse(result.text);
    expect(report).toMatchObject({ mode: 'stub', views: [{ id: 'aml-cycle', status: 'ok' }], totals: { viewsRun: 1 } });
  });

  it('refuses a settings problem naming the variable and never its value', async () => {
    const result = await cli(['--stub'], { NEBURYX_SUMMARY_MAX_CALLS: 'SENTINEL-NOT-A-NUMBER' });
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('NEBURYX_SUMMARY_MAX_CALLS');
    expect(result.err.join('\n')).not.toContain('SENTINEL-NOT-A-NUMBER');
  });
});
