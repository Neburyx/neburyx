import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { docker, dockerOk, type DockerResult } from '../image/docker.js';

export const repository = fileURLToPath(new URL('../../../../', import.meta.url));
export const composeFile = join(repository, 'deploy/compose/compose.yaml');
export const demoComposeFile = join(repository, 'deploy/demo/compose.yaml');
const WAIT_SECONDS = 150;
/**
 * How long `docker compose up --wait` may wait for the demo stack. A full start takes 38 s here with every container on
 * two CPUs. On the CI runner it is inferred, not measured directly, to be about 220 s on a cold runner (run
 * 41593551817), and a wait of 150 s expired while the second graph was still starting (run 41600744318). 600 s is
 * more than two and a half times the inferred figure. The Community stack keeps 150 s: its tests time out at 300 s.
 */
export const DEMO_WAIT_SECONDS = 600;

const inspectSchema = z.object({
  Name: z.string(),
  State: z.object({
    Status: z.string(),
    ExitCode: z.number(),
    Health: z.object({ Status: z.string(), FailingStreak: z.number(), Log: z.array(z.object({ Start: z.string(), End: z.string(), ExitCode: z.number(), Output: z.string() })).nullable().transform((log) => log ?? []).optional() }).optional(),
  }),
});

export function maskSecrets(text: string, secrets: readonly string[]): string {
  return [...new Set(secrets)]
    .filter((secret) => secret !== '')
    .sort((left, right) => right.length - left.length)
    .reduce((masked, secret) => masked.replaceAll(secret, '***'), text);
}

/** One line per container (and its last three health checks), from `docker inspect` JSON, with every secret masked before anything is shortened. */
export function describeContainers(inspections: readonly string[], secrets: readonly string[]): string {
  return inspections
    .map((raw, position) => {
      let parsed: ReturnType<typeof inspectSchema.safeParse>;
      try {
        parsed = inspectSchema.safeParse(JSON.parse(raw));
      } catch {
        return `container ${position + 1}: could not be inspected`;
      }
      if (!parsed.success) return `container ${position + 1}: could not be inspected`;
      const { Name, State } = parsed.data;
      const checks = (State.Health?.Log ?? []).slice(-3).map((entry) => `[exit ${entry.ExitCode}, ${entry.Start} to ${entry.End}] ${maskSecrets(entry.Output, secrets).trim().slice(0, 200)}`);
      const health = State.Health === undefined ? '' : `, health ${State.Health.Status} (failing streak ${State.Health.FailingStreak})`;
      return maskSecrets(`${Name.replace(/^\//, '')}: ${State.Status}, exit code ${State.ExitCode}${health}${checks.length === 0 ? '' : `\n  last health checks: ${checks.join(' | ')}`}`, secrets);
    })
    .join('\n');
}

const eventSchema = z.object({
  Action: z.string(),
  timeNano: z.number(),
  Actor: z.object({ Attributes: z.record(z.string(), z.string()) }),
});
export type ContainerEvent = z.infer<typeof eventSchema>;

export interface StackOptions {
  readonly image: string;
  readonly tag: string;
  readonly omit?: readonly string[];
  readonly overrides?: readonly string[];
  readonly file?: string;
  readonly settings?: Readonly<Record<string, string>>;
  readonly waitSeconds?: number;
}

export class Stack {
  readonly project = `neburyx-test-${randomBytes(4).toString('hex')}`;
  readonly passwords = {
    NEBURYX_DB_ADMIN_PASSWORD: randomBytes(12).toString('hex'),
    NEBURYX_DB_MIGRATION_PASSWORD: randomBytes(12).toString('hex'),
    NEBURYX_DB_APP_PASSWORD: randomBytes(12).toString('hex'),
  };
  private readonly folder = mkdtempSync(join(tmpdir(), 'compose-stack-'));
  private readonly envFile = join(this.folder, 'settings.env');
  readonly commands: (readonly string[])[] = [];
  private tag: string;

  private constructor(
    readonly port: number,
    private readonly options: StackOptions,
  ) {
    this.tag = options.tag;
    this.writeSettings();
  }

  static async create(options: StackOptions): Promise<Stack> {
    return new Stack(await freePort(), options);
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  setTag(tag: string): void {
    this.tag = tag;
    this.writeSettings();
  }

  private writeSettings(): void {
    const values: Record<string, string> = { ...this.passwords, ...this.options.settings, NEBURYX_IMAGE: this.options.image, NEBURYX_TAG: this.tag, NEBURYX_PORT: String(this.port) };
    for (const name of this.options.omit ?? []) delete values[name];
    mkdirSync(this.folder, { recursive: true });
    writeFileSync(this.envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  }

  compose(args: readonly string[]): Promise<DockerResult> {
    this.commands.push([...args]);
    const files = [this.options.file ?? composeFile, ...(this.options.overrides ?? [])].flatMap((file) => ['-f', file]);
    return docker(['compose', '-p', this.project, ...files, '--env-file', this.envFile, ...args]);
  }

  async up(): Promise<DockerResult> {
    const result = await this.compose(['up', '--wait', '--wait-timeout', String(this.options.waitSeconds ?? WAIT_SECONDS)]);
    return result.code === 0 ? result : { ...result, stderr: `${result.stderr}\n${await this.diagnostics()}` };
  }

  /** What each container of the project looked like. Best effort: it never throws, so it cannot replace the failure it explains. */
  async diagnostics(): Promise<string> {
    const secrets = [...Object.values(this.passwords), ...Object.values(this.options.settings ?? {})];
    try {
      const ids = (await dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`])).split('\n').filter(Boolean);
      const inspections = await Promise.all(ids.map(async (id) => (await docker(['inspect', '--format', '{{json .}}', id])).stdout));
      return describeContainers(inspections, secrets);
    } catch (error) {
      return maskSecrets(`the containers could not be described: ${error instanceof Error ? error.message : 'unknown error'}`, secrets);
    }
  }

  record(): Promise<EventRecorder> {
    return EventRecorder.start(this.project, `${this.options.image}:${this.tag}`);
  }

  async containerId(service: string): Promise<string> {
    return dockerOk(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.project}`, '--filter', `label=com.docker.compose.service=${service}`]);
  }

  async psql(sql: string, role = 'postgres', database = 'neburyx'): Promise<DockerResult> {
    const password = role === 'neburyx_app' ? this.passwords.NEBURYX_DB_APP_PASSWORD : role === 'neburyx_migrate' ? this.passwords.NEBURYX_DB_MIGRATION_PASSWORD : this.passwords.NEBURYX_DB_ADMIN_PASSWORD;
    return this.compose(['exec', '-T', '-e', `PGPASSWORD=${password}`, 'db', 'psql', '-h', '127.0.0.1', '-U', role, '-d', database, '-tA', '-c', sql]);
  }

  async events(sinceNano: number): Promise<readonly ContainerEvent[]> {
    const output = await dockerOk([
      'events', '--since', String(Math.floor(sinceNano / 1e9)), '--until', String(Math.ceil(Date.now() / 1000) + 1),
      '--filter', `label=com.docker.compose.project=${this.project}`, '--filter', 'type=container', '--format', '{{json .}}',
    ]);
    return output.split('\n').filter(Boolean).map((line) => eventSchema.parse(JSON.parse(line))).filter((event) => event.timeNano >= sinceNano);
  }

  async destroy(): Promise<void> {
    await this.compose(['down', '-v', '--remove-orphans', '--timeout', '5']);
    const label = `label=com.docker.compose.project=${this.project}`;
    const left = [
      await dockerOk(['ps', '-aq', '--filter', label]),
      await dockerOk(['network', 'ls', '-q', '--filter', label]),
      await dockerOk(['volume', 'ls', '-q', '--filter', label]),
    ];
    if (left.some((found) => found !== '')) throw new Error(`containers, networks or volumes of project ${this.project} are still present after docker compose down`);
    rmSync(this.folder, { recursive: true, force: true });
  }
}

/**
 * Collects the start and die events of a project's containers as they happen. `docker events --since` replays from the
 * daemon's buffer of 256 events, which the health checks of a busy stack overflow, so a test that reads after the fact
 * can lose the first events.
 */
export class EventRecorder {
  readonly events: ContainerEvent[] = [];
  private readonly child: ChildProcessByStdio<null, Readable, null>;
  private readonly closed: Promise<void>;
  private rest = '';
  private failure: Error | undefined;

  private constructor(
    private readonly project: string,
    private readonly markerImage: string,
  ) {
    this.child = spawn(
      'docker',
      ['events', '--since', String(Math.floor(Date.now() / 1000) - 1), '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'type=container', '--filter', 'event=start', '--filter', 'event=die', '--filter', 'event=create', '--format', '{{json .}}'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      try {
        this.read(chunk);
      } catch (error) {
        this.failure ??= error instanceof Error ? error : new Error('the event recorder could not read an event');
      }
    });
    this.child.once('error', (error) => {
      this.failure ??= error;
    });
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()));
  }

  /** Starts the stream and returns once it is subscribed: a marker created after the start is seen. */
  static async start(project: string, markerImage: string): Promise<EventRecorder> {
    const recorder = new EventRecorder(project, markerImage);
    try {
      await recorder.sync();
    } catch (error) {
      await recorder.stop();
      throw error;
    }
    return recorder;
  }

  private read(chunk: string): void {
    const lines = (this.rest + chunk).split('\n');
    this.rest = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) this.events.push(eventSchema.parse(JSON.parse(line)));
  }

  private check(): void {
    if (this.failure !== undefined) throw new Error(`the event recorder failed: ${this.failure.message}`);
  }

  /** Returns once every event that happened before the call has been recorded: events arrive in order, so a container created now is seen after them. */
  async sync(): Promise<void> {
    const marker = randomBytes(6).toString('hex');
    const id = await dockerOk(['create', '--label', `com.docker.compose.project=${this.project}`, '--label', `neburyx.marker=${marker}`, this.markerImage]);
    try {
      const deadline = Date.now() + 30_000;
      while (!this.events.some((event) => event.Actor.Attributes['neburyx.marker'] === marker)) {
        this.check();
        if (Date.now() > deadline) throw new Error('the event recorder did not see its marker');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      const removed = await docker(['rm', '-f', id]);
      if (removed.code !== 0) throw new Error(`the marker container ${id.slice(0, 12)} could not be removed: ${removed.stderr.slice(-300)}`);
    }
  }

  since(sinceNano: number): ContainerEvent[] {
    this.check();
    return this.events.filter((event) => event.timeNano >= sinceNano && event.Actor.Attributes['neburyx.marker'] === undefined);
  }

  async stop(): Promise<void> {
    this.child.kill();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await this.closed;
    clearTimeout(timer);
  }
}

export function serviceOf(event: ContainerEvent): string | undefined {
  return event.Actor.Attributes['com.docker.compose.service'];
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      server.close(() => resolve(address.port));
    });
  });
}

export async function buildDerivedImage(base: string, tag: string, migrationName: string, sql: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'compose-image-'));
  try {
    writeFileSync(join(folder, migrationName), sql);
    writeFileSync(join(folder, 'Dockerfile'), `FROM ${base}\nCOPY ${migrationName} /app/migrations/${migrationName}\n`);
    await dockerOk(['build', '-q', '-t', tag, folder]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
