import { describe, expect, it } from 'vitest';
import { ExperimentError } from './errors.js';
import { findings } from './fixtures.js';
import { DEFAULT_IMAGES, parseArgs, runCheck } from './run.js';
import type { Server } from './server.js';

function capture(): { out: string[]; err: string[]; io: { out(t: string): void; err(t: string): void } } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (t) => out.push(t), err: (t) => err.push(t) } };
}

function server(image: string, stopped: string[], stop: () => Promise<void> = () => Promise.resolve()): Server {
  return {
    image,
    boltUri: 'bolt://x',
    user: 'u',
    password: 'p',
    stop: async () => {
      stopped.push(image);
      await stop();
    },
  };
}

describe('runCheck', () => {
  it('exits 1 with a message and prints no result when the container cannot start', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['neo4j:test'], io, {
      start: () => Promise.reject(new Error('Could not find a working container runtime strategy')),
      execute: () => Promise.reject(new Error('not reached')),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['the check could not run on neo4j:test: Could not find a working container runtime strategy']);
  });

  it('prints no result when only the second image fails, and stops the first server', async () => {
    const { out, err, io } = capture();
    const stopped: string[] = [];
    const code = await runCheck(['a', 'b'], io, {
      start: (image) => (image === 'b' ? Promise.reject(new Error('pull failed')) : Promise.resolve(server(image, stopped))),
      execute: () => Promise.resolve(findings()),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toHaveLength(1);
    expect(stopped).toEqual(['a']);
  });

  it('stops a server whose experiment failed, and prints no result', async () => {
    const { out, io } = capture();
    const stopped: string[] = [];
    const code = await runCheck(['a'], io, {
      start: (image) => Promise.resolve(server(image, stopped)),
      execute: () => Promise.reject(new Error('boom')),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(stopped).toEqual(['a']);
  });

  it('prints one report for all images and exits 0 when every one ran and cleaned up', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['a'], io, {
      start: (image) => Promise.resolve(server(image, [])),
      execute: () => Promise.resolve(findings()),
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(err).toEqual([]);
  });

  it('prints the report but exits 2 and names the problem when a container could not be stopped', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['a'], io, {
      start: (image) => Promise.resolve(server(image, [], () => Promise.reject(new Error('still busy')))),
      execute: () => Promise.resolve(findings()),
    });
    expect(code).toBe(2);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('the container of a may still be running: still busy');
    expect(err).toEqual(['cleanup problem: the container of a may still be running: still busy']);
  });

  it('prints the report but exits 2 when an experiment reports a cleanup failure', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['a'], io, {
      start: (image) => Promise.resolve(server(image, [])),
      execute: () => Promise.resolve(findings({ cleanupFailures: ['driver of the timeout run: did not finish within 5000 ms'] })),
    });
    expect(code).toBe(2);
    expect(out).toHaveLength(1);
    expect(err).toEqual(['cleanup problem: driver of the timeout run: did not finish within 5000 ms']);
  });
});

describe('runCheck diagnostics on failure', () => {
  it('prints the cleanup problems an experiment found before it failed, still with exit 1 and no result', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['a'], io, {
      start: (image) => Promise.resolve(server(image, [])),
      execute: () => Promise.reject(new ExperimentError(new Error('cannot begin'), ['session of the preparation: none'])),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['the check could not run on a: cannot begin', 'cleanup problem: session of the preparation: none']);
  });

  it('prints the cleanup problems of an earlier image when a later image cannot start', async () => {
    const { out, err, io } = capture();
    const code = await runCheck(['a', 'b'], io, {
      start: (image) => (image === 'b' ? Promise.reject(new Error('pull failed')) : Promise.resolve(server(image, []))),
      execute: () => Promise.resolve(findings({ cleanupFailures: ['driver of the timeout run: did not finish within 5000 ms'] })),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err).toEqual(['the check could not run on b: pull failed', 'cleanup problem: driver of the timeout run: did not finish within 5000 ms']);
  });
});

describe('parseArgs', () => {
  it('defaults to the LTS and the current release, and takes --image', () => {
    expect(parseArgs([])).toEqual({ images: DEFAULT_IMAGES });
    expect(parseArgs(['--image', 'neo4j:5.26'])).toEqual({ images: ['neo4j:5.26'] });
    expect(parseArgs(['--image', 'a', '--image', 'b'])).toEqual({ images: ['a', 'b'] });
  });

  it('accepts the separator a package manager puts before the arguments', () => {
    expect(parseArgs(['--', '--image', 'neo4j:5.26'])).toEqual({ images: ['neo4j:5.26'] });
  });

  it('rejects an unknown argument, a missing value and a value that is another option', () => {
    expect(parseArgs(['--imagee', 'x'])).toEqual({ error: 'unknown argument: --imagee' });
    expect(parseArgs(['--image'])).toEqual({ error: '--image needs a value' });
    expect(parseArgs(['--image', '--other'])).toEqual({ error: '--image needs a value' });
    expect(parseArgs(['stray'])).toEqual({ error: 'unknown argument: stray' });
  });
});
