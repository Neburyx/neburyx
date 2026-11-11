import { describe, expect, it } from 'vitest';
import { createExec } from './exec.js';

const idle = { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] };

describe('createExec', () => {
  it('reports a program that does not exist as a start error', async () => {
    const result = await createExec(new AbortController().signal, {})({ command: 'no-such-program-here', args: [] });
    expect(result.startError).toContain('ENOENT');
    expect(result.exitCode).toBeNull();
  });

  it('stops a program that runs past its timeout', async () => {
    const result = await createExec(new AbortController().signal, {})({ ...idle, timeoutMs: 200 });
    expect(result).toMatchObject({ timedOut: true, exitCode: null });
  });

  it('stops a running program when the run is interrupted', async () => {
    const controller = new AbortController();
    const pending = createExec(controller.signal, {})(idle);
    setTimeout(() => controller.abort(), 200);
    expect(await pending).toMatchObject({ interrupted: true, exitCode: null });
  });

  it('collects the output of both streams and the exit code', async () => {
    const result = await createExec(new AbortController().signal, {})({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err"); process.exit(4)'] });
    expect(result.exitCode).toBe(4);
    expect(result.output).toContain('out');
    expect(result.output).toContain('err');
  });

  it('passes the request environment over the base one', async () => {
    const result = await createExec(new AbortController().signal, { NBX_TEST_VALUE: 'base' })({ command: process.execPath, args: ['-e', 'console.log(process.env.NBX_TEST_VALUE)'], env: { NBX_TEST_VALUE: 'request' } });
    expect(result.output.trim()).toBe('request');
  });
});
