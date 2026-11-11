import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describeCommand, execFailure } from './command-check.js';
import { packNames } from './packs.js';
import { DOCKER_UNREACHABLE, dockerReachable } from './vitest-run.js';
import type { Check, CheckContext, CheckOutcome, ExecRequest, ExecResult } from './types.js';

/** The limit of the demo install: 15 minutes. */
export const INSTALL_LIMIT_MS = 900_000;

export const CLOCK_DEFINITION =
  'The clock starts immediately before the docker build of the product image, on a machine with no containers, volumes or networks of the demo project and with the product image tag and the demo loader image removed, so that both builds happen inside the clock. ' +
  'The base images (Neo4j, Postgres, the Node base) are those on the machine before the run; the record says whether each was there. ' +
  'The clock stops when docker compose up --wait has returned 0, GET /readyz answers ready and GET /v1/sources lists every demo source as connected. ' +
  'With a supplied image the build is not timed.';

const COMPOSE_FILE = 'deploy/demo/compose.yaml';
const DOCKERFILES = ['deploy/docker/Dockerfile', 'deploy/demo/loader.Dockerfile'] as const;
const DOCKERFILE = 'deploy/docker/Dockerfile';
const POLL_INTERVAL_MS = 1000;
const HTTP_OK = 200;
const SHORT_COMMIT_LENGTH = 7;
const SECRET_BYTES = 12;
const CURSOR_KEY_BYTES = 32;

const sourcesSchema = z.object({ items: z.array(z.object({ id: z.string(), state: z.string() })) });

export interface DemoInstallDeps {
  readonly freePort: () => Promise<number>;
  readonly httpGet: (url: string) => Promise<{ readonly status: number; readonly body: string }>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly randomHex: (bytes: number) => string;
  readonly randomBase64: (bytes: number) => string;
  /** Writes the settings to a file outside the repository and returns its path and a function that deletes it. */
  readonly writeSettings: (content: string) => Promise<{ readonly path: string; readonly remove: () => Promise<void> }>;
}

export const realDemoInstallDeps: DemoInstallDeps = {
  freePort: () =>
    new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address !== null ? address.port : 0;
        server.close(() => resolve(port));
      });
    }),
  httpGet: async (url) => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: await response.text() };
    } catch {
      return { status: 0, body: '' };
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomHex: (bytes) => randomBytes(bytes).toString('hex'),
  randomBase64: (bytes) => randomBytes(bytes).toString('base64'),
  writeSettings: async (content) => {
    const folder = await mkdtemp(join(tmpdir(), 'release-demo-'));
    const path = join(folder, 'demo.env');
    await writeFile(path, content, { mode: 0o600 });
    return { path, remove: () => rm(folder, { recursive: true, force: true }) };
  },
};

function splitImage(name: string): { readonly repository: string; readonly tag: string } {
  const colon = name.lastIndexOf(':');
  return colon > name.lastIndexOf('/') ? { repository: name.slice(0, colon), tag: name.slice(colon + 1) } : { repository: name, tag: 'latest' };
}

export interface DemoInstallOptions {
  /** An image that is already built: the build is not timed. */
  readonly image?: string;
  readonly deps?: DemoInstallDeps;
}

export function demoInstallCheck(options: DemoInstallOptions = {}): Check {
  const deps = options.deps ?? realDemoInstallDeps;
  const command = `docker build ${DOCKERFILE}; docker compose -f ${COMPOSE_FILE} up --wait`;
  return {
    id: 'demo-install',
    name: 'Demo-graph install within 15 minutes',
    command,
    run: async (context: CheckContext): Promise<CheckOutcome> => {
      const log: string[] = [];
      const base = (status: 'passed' | 'failed', detail: string, data: unknown): CheckOutcome => ({ status, detail, command, exitCode: status === 'passed' ? 0 : null, output: log.join(''), data });
      if (!(await dockerReachable(context))) return base('failed', DOCKER_UNREACHABLE, { clock: CLOCK_DEFINITION });

      const shortCommit = context.commit.slice(0, SHORT_COMMIT_LENGTH);
      const supplied = options.image !== undefined;
      const productName = options.image ?? `neburyx-release-check:${shortCommit}`;
      const product = splitImage(productName);
      const loaderImage = `neburyx-release-check-loader:${shortCommit}`;
      const run = async (request: ExecRequest): Promise<ExecResult> => {
        const result = await context.exec({ ...request, cwd: context.repoRoot });
        log.push(`$ ${describeCommand(request)}\n${result.output}\n`);
        return result;
      };
      if (supplied) {
        const found = await run({ command: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', productName] });
        if (found.exitCode !== 0) return base('failed', `the supplied image does not exist: ${productName}`, { clock: CLOCK_DEFINITION });
      }

      const expectedSources = packNames(context.repoRoot).length;
      const port = await deps.freePort();
      const settings = await deps.writeSettings(
        [
          `NEBURYX_DB_ADMIN_PASSWORD=${deps.randomHex(SECRET_BYTES)}`,
          `NEBURYX_DB_MIGRATION_PASSWORD=${deps.randomHex(SECRET_BYTES)}`,
          `NEBURYX_DB_APP_PASSWORD=${deps.randomHex(SECRET_BYTES)}`,
          `DEMO_NEO4J_PASSWORD=${deps.randomHex(SECRET_BYTES)}`,
          `NEBURYX_CURSOR_KEY=${deps.randomBase64(CURSOR_KEY_BYTES)}`,
          `NEBURYX_IMAGE=${product.repository}`,
          `NEBURYX_TAG=${product.tag}`,
          `NEBURYX_PORT=${port}`,
          `NEBURYX_DEMO_LOADER_IMAGE=${loaderImage}`,
          '',
        ].join('\n'),
      );
      const compose = (...args: string[]): ExecRequest => ({ command: 'docker', args: ['compose', '--env-file', settings.path, '-f', COMPOSE_FILE, ...args] });
      const teardown = (): Promise<ExecResult> => run({ ...compose('down', '-v', '--remove-orphans'), ignoreInterrupt: true });
      try {
        await teardown();
        await run({ command: 'docker', args: ['image', 'rm', '-f', loaderImage] });
        if (!supplied) await run({ command: 'docker', args: ['image', 'rm', '-f', productName] });

        const listed = await run(compose('config', '--images'));
        const own = new Set([productName, loaderImage]);
        const fromDockerfiles = (await Promise.all(DOCKERFILES.map((file) => readFile(join(context.repoRoot, file), 'utf8').then(dockerfileBaseImages)))).flat();
        const baseImages = await Promise.all(
          [...new Set([...listed.output.split('\n').map((line) => line.trim()), ...fromDockerfiles])]
            .filter((line) => line !== '' && !own.has(line) && !line.startsWith('$'))
            .map(async (name) => ({ name, presentBeforeClock: (await run({ command: 'docker', args: ['image', 'inspect', name] })).exitCode === 0 })),
        );

        const startedAt = context.monotonicNowMs();
        const remaining = (): number => Math.max(1, INSTALL_LIMIT_MS - (context.monotonicNowMs() - startedAt));
        const figures = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({ clock: CLOCK_DEFINITION, limitMs: INSTALL_LIMIT_MS, image: { name: productName, supplied }, baseImages, ...extra });
        const stopped = (step: string): CheckOutcome => base('failed', `over ${INSTALL_LIMIT_MS} ms at step ${step} (${Math.round(context.monotonicNowMs() - startedAt)} ms elapsed)`, figures({ elapsedMs: Math.round(context.monotonicNowMs() - startedAt), failedStep: step }));
        const failedAt = (step: string, result: ExecResult): CheckOutcome => {
          if (result.timedOut) return stopped(step);
          return base('failed', `${step}: ${execFailure(result, undefined) ?? 'failed'}`, figures({ failedStep: step }));
        };

        let buildMs = 0;
        if (!supplied) {
          const built = await run({ command: 'docker', args: ['build', '--no-cache', '-f', DOCKERFILE, '-t', productName, '.'], timeoutMs: remaining() });
          if (execFailure(built, undefined) !== undefined) return failedAt('build', built);
          buildMs = Math.round(context.monotonicNowMs() - startedAt);
        }
        const up = await run({ ...compose('up', '--wait'), timeoutMs: remaining() });
        if (execFailure(up, undefined) !== undefined) return failedAt('up', up);

        const ready = await pollUntil(deps, context, startedAt, async () => (await deps.httpGet(`http://127.0.0.1:${port}/readyz`)).status === HTTP_OK);
        if (!ready) return stopped('readiness');
        const connected = await pollUntil(deps, context, startedAt, async () => sourcesAreConnected((await deps.httpGet(`http://127.0.0.1:${port}/v1/sources`)).body, expectedSources));
        if (!connected) return stopped('sources');

        const elapsedMs = Math.round(context.monotonicNowMs() - startedAt);
        const inspected = await run({ command: 'docker', args: ['image', 'inspect', '--format', '{{.Id}}', productName] });
        const data = figures({ elapsedMs, buildMs, restMs: elapsedMs - buildMs, image: { name: productName, id: inspected.output.trim(), supplied, buildTimed: !supplied } });
        const detail = `${elapsedMs} ms (build ${buildMs} ms, rest ${elapsedMs - buildMs} ms), limit ${INSTALL_LIMIT_MS} ms${supplied ? '; image supplied: the build was not timed' : ''}`;
        return elapsedMs <= INSTALL_LIMIT_MS ? base('passed', detail, data) : base('failed', `over the limit: ${detail}`, data);
      } finally {
        await teardown();
        await settings.remove();
      }
    },
  };
}

/** The images a Dockerfile starts from, leaving out the stages it defines itself. */
export function dockerfileBaseImages(text: string): readonly string[] {
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of text.split('\n')) {
    const match = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line.trim());
    if (match?.[1] === undefined) continue;
    if (match[1] !== 'scratch' && !stages.has(match[1])) images.push(match[1]);
    if (match[2] !== undefined) stages.add(match[2]);
  }
  return images;
}

function sourcesAreConnected(body: string, expected: number): boolean {
  try {
    const parsed = sourcesSchema.parse(JSON.parse(body));
    return parsed.items.length === expected && parsed.items.every((item) => item.state === 'connected');
  } catch {
    return false;
  }
}

/** Probes at least once, then every second until the limit; a probe that answers at the limit still counts. */
async function pollUntil(deps: DemoInstallDeps, context: CheckContext, startedAt: number, probe: () => Promise<boolean>): Promise<boolean> {
  for (;;) {
    if (context.signal.aborted) return false;
    if (await probe()) return true;
    if (context.monotonicNowMs() - startedAt >= INSTALL_LIMIT_MS) return false;
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
