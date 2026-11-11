import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOCK_DEFINITION, dockerfileBaseImages, demoInstallCheck, INSTALL_LIMIT_MS, type DemoInstallDeps } from './demo-install.js';
import { execResult } from './testing.js';
import type { CheckContext, ExecRequest, ExecResult } from './types.js';

const SOURCES_OK = JSON.stringify({ items: [{ id: 'a-demo', state: 'connected' }, { id: 'b-demo', state: 'connected' }] });
const SECRET = 'generated-secret-value';

interface Options {
  readonly dockerUp?: boolean;
  readonly buildMs?: number;
  readonly upMs?: number;
  readonly upExit?: number;
  readonly upTimedOut?: boolean;
  readonly ready?: boolean;
  readonly sources?: string;
  readonly suppliedExists?: boolean;
  readonly image?: string;
  readonly aborted?: boolean;
}

function setup(options: Options = {}) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'demo-repo-'));
  for (const pack of ['alpha', 'beta']) {
    mkdirSync(join(repoRoot, 'domain-packs', pack), { recursive: true });
    writeFileSync(join(repoRoot, 'domain-packs', pack, 'neburyx.yaml'), '');
  }
  mkdirSync(join(repoRoot, 'deploy', 'docker'), { recursive: true });
  mkdirSync(join(repoRoot, 'deploy', 'demo'), { recursive: true });
  writeFileSync(join(repoRoot, 'deploy', 'docker', 'Dockerfile'), 'FROM node:24-slim AS builder\nRUN x\nFROM node:24-slim\nCOPY --from=builder /a /b\n');
  writeFileSync(join(repoRoot, 'deploy', 'demo', 'loader.Dockerfile'), 'FROM node:24-slim AS builder\nFROM node:24-slim\n');
  let now = 1000;
  const requests: ExecRequest[] = [];
  const settings = { content: '', removed: false };
  const controller = new AbortController();
  if (options.aborted === true) controller.abort();
  const verb = (request: ExecRequest): string => (request.command === 'docker' ? (request.args[0] === 'compose' ? `compose ${request.args.slice(5).join(' ')}` : request.args.join(' ')) : request.command);
  const exec = (request: ExecRequest): Promise<ExecResult> => {
    requests.push(request);
    const key = verb(request);
    if (key.startsWith('info')) return Promise.resolve(execResult({ exitCode: options.dockerUp === false ? 1 : 0 }));
    if (key.startsWith('image inspect --format')) return Promise.resolve(execResult({ exitCode: options.suppliedExists === false ? 1 : 0, output: 'sha256:image-id\n' }));
    if (key.startsWith('image inspect')) return Promise.resolve(execResult({ exitCode: ['neo4j:5.26', 'node:24-slim'].includes(request.args.at(-1) ?? '') ? 0 : 1 }));
    if (key === 'compose config --images') return Promise.resolve(execResult({ output: 'neo4j:5.26\nneo4j:5.26\npostgres:17\nneburyx-release-check:abcdef0\nneburyx-release-check-loader:abcdef0\n' }));
    if (key.startsWith('build')) {
      now += options.buildMs ?? 100;
      return Promise.resolve(execResult());
    }
    if (key === 'compose up --wait') {
      now += options.upMs ?? 200;
      return Promise.resolve(options.upTimedOut === true ? execResult({ exitCode: null, timedOut: true }) : execResult({ exitCode: options.upExit ?? 0 }));
    }
    return Promise.resolve(execResult());
  };
  const deps: DemoInstallDeps = {
    freePort: () => Promise.resolve(4321),
    httpGet: (url) => Promise.resolve(url.endsWith('/readyz') ? { status: options.ready === false ? 503 : 200, body: '' } : { status: 200, body: options.sources ?? SOURCES_OK }),
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    randomHex: () => SECRET,
    randomBase64: () => SECRET,
    writeSettings: (content) => {
      settings.content = content;
      return Promise.resolve({ path: '/tmp/outside/demo.env', remove: () => Promise.resolve().then(() => void (settings.removed = true)) });
    },
  };
  const context: CheckContext = { exec, signal: controller.signal, repoRoot, commit: 'abcdef0123456789', monotonicNowMs: () => now, workDir: '/work', env: {} };
  const check = demoInstallCheck({ deps, ...(options.image === undefined ? {} : { image: options.image }) });
  const verbs = (): string[] => requests.map(verb);
  return { check, context, requests, settings, verbs, advance: (ms: number) => void (now += ms) };
}

describe('demoInstallCheck failures', () => {
  it('fails when Docker is not reachable and starts nothing', async () => {
    const { check, context, verbs } = setup({ dockerUp: false });
    expect(await check.run(context)).toMatchObject({ status: 'failed', detail: 'Docker is not reachable' });
    expect(verbs()).toEqual(['info --format {{.ServerVersion}}']);
  });

  it('fails with the step and the code when up fails, and still takes the stack down and deletes the settings', async () => {
    const { check, context, verbs, settings } = setup({ upExit: 1 });
    expect(await check.run(context)).toMatchObject({ status: 'failed', detail: 'up: exited with code 1' });
    expect(verbs().at(-1)).toBe('compose down -v --remove-orphans');
    expect(settings.removed).toBe(true);
  });

  it('stops a step that runs to the limit and names it', async () => {
    const { check, context } = setup({ upMs: INSTALL_LIMIT_MS, upTimedOut: true });
    expect(await check.run(context)).toMatchObject({ status: 'failed', detail: expect.stringContaining('over 900000 ms at step up') });
  });

  it('fails at readiness, and at sources, when they do not come up within the limit', async () => {
    const notReady = setup({ ready: false });
    expect(await notReady.check.run(notReady.context)).toMatchObject({ status: 'failed', detail: expect.stringContaining('at step readiness') });
    const noSources = setup({ sources: JSON.stringify({ items: [{ id: 'a-demo', state: 'connected' }, { id: 'b-demo', state: 'unreachable' }] }) });
    expect(await noSources.check.run(noSources.context)).toMatchObject({ status: 'failed', detail: expect.stringContaining('at step sources') });
  });

  it('takes the stack down with an interrupt-proof request, so a clean-up runs after an interrupt', async () => {
    const { check, context, requests } = setup({ aborted: true });
    await check.run(context);
    const downs = requests.filter((request) => request.args.includes('down'));
    expect(downs.length).toBeGreaterThan(0);
    expect(downs.every((request) => request.ignoreInterrupt === true)).toBe(true);
  });
});

describe('demoInstallCheck timing', () => {
  it('passes at exactly 900,000 ms and fails one millisecond over', async () => {
    const at = setup({ buildMs: 400_000, upMs: 500_000 });
    expect(await at.check.run(at.context)).toMatchObject({ status: 'passed' });
    const over = setup({ buildMs: 400_000, upMs: 500_001 });
    expect(await over.check.run(over.context)).toMatchObject({ status: 'failed', detail: expect.stringContaining('over the limit') });
  });

  it('gives each step the time that is left of the 900,000 ms', async () => {
    const { check, context, requests } = setup({ buildMs: 300_000 });
    await check.run(context);
    expect(requests.find((request) => request.args[0] === 'build')?.timeoutMs).toBe(INSTALL_LIMIT_MS);
    expect(requests.find((request) => request.args.includes('up'))?.timeoutMs).toBe(INSTALL_LIMIT_MS - 300_000);
  });

  it('records the build, the rest and the total, the clock text, the image and the base images with whether each was there', async () => {
    const { check, context } = setup({ buildMs: 100, upMs: 200 });
    const outcome = await check.run(context);
    expect(outcome.data).toMatchObject({
      elapsedMs: 300,
      buildMs: 100,
      restMs: 200,
      clock: CLOCK_DEFINITION,
      image: { name: 'neburyx-release-check:abcdef0', id: 'sha256:image-id', supplied: false, buildTimed: true },
      baseImages: [{ name: 'neo4j:5.26', presentBeforeClock: true }, { name: 'postgres:17', presentBeforeClock: false }, { name: 'node:24-slim', presentBeforeClock: true }],
    });
  });
});

describe('demoInstallCheck clean state', () => {
  it('removes the stack, the loader image and the product tag before the clock, builds without cache, then waits for up', async () => {
    const { check, context, verbs } = setup();
    expect(await check.run(context)).toMatchObject({ status: 'passed' });
    const order = verbs();
    expect(order.slice(0, 5)).toEqual(['info --format {{.ServerVersion}}', 'compose down -v --remove-orphans', 'image rm -f neburyx-release-check-loader:abcdef0', 'image rm -f neburyx-release-check:abcdef0', 'compose config --images']);
    expect(order.indexOf('compose up --wait')).toBeGreaterThan(order.findIndex((verb) => verb.startsWith('build --no-cache -f deploy/docker/Dockerfile')));
    expect(order.at(-1)).toBe('compose down -v --remove-orphans');
  });

  it('touches only the two image tags it names, never an image it was given', async () => {
    const { check, context, verbs } = setup({ image: 'neburyx-release-check:abcdef0' });
    const outcome = await check.run(context);
    expect(outcome).toMatchObject({ status: 'passed', detail: expect.stringContaining('image supplied: the build was not timed') });
    expect(verbs().filter((verb) => verb.startsWith('image rm'))).toEqual(['image rm -f neburyx-release-check-loader:abcdef0']);
    expect(verbs().some((verb) => verb.startsWith('build'))).toBe(false);
    expect(outcome.data).toMatchObject({ image: { supplied: true, buildTimed: false } });
  });

  it('fails a supplied image that does not exist before the clock, starting no stack', async () => {
    const { check, context, verbs } = setup({ image: 'missing:1', suppliedExists: false });
    expect(await check.run(context)).toMatchObject({ status: 'failed', detail: 'the supplied image does not exist: missing:1' });
    expect(verbs().some((verb) => verb.startsWith('compose'))).toBe(false);
  });
});

describe('demoInstallCheck settings', () => {
  it('makes the settings fresh, outside the repository, and keeps their values out of the record and the log', async () => {
    const { check, context, settings, requests } = setup();
    const outcome = await check.run(context);
    expect(settings.content).toContain(`NEBURYX_PORT=4321`);
    expect(settings.content).toContain(SECRET);
    expect(settings.removed).toBe(true);
    expect(requests.every((request) => request.args.includes('/tmp/outside/demo.env') || !request.args.includes('--env-file'))).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });
});

describe('dockerfileBaseImages', () => {
  it('lists the images a Dockerfile starts from, once for each stage, and leaves out its own stages and scratch', () => {
    expect(dockerfileBaseImages('FROM node:24 AS build\nFROM build AS test\nFROM scratch\nFROM --platform=linux/amd64 alpine:3 AS final\n')).toEqual(['node:24', 'alpine:3']);
  });
});
