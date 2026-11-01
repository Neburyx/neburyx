import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { docker, dockerOk, type DockerResult } from '../image/docker.js';

export const repository = fileURLToPath(new URL('../../../../', import.meta.url));
export const composeFile = join(repository, 'deploy/compose/compose.yaml');
const WAIT_SECONDS = 150;

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
    const values: Record<string, string> = { ...this.passwords, NEBURYX_IMAGE: this.options.image, NEBURYX_TAG: this.tag, NEBURYX_PORT: String(this.port) };
    for (const name of this.options.omit ?? []) delete values[name];
    mkdirSync(this.folder, { recursive: true });
    writeFileSync(this.envFile, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  }

  compose(args: readonly string[]): Promise<DockerResult> {
    this.commands.push([...args]);
    const files = [composeFile, ...(this.options.overrides ?? [])].flatMap((file) => ['-f', file]);
    return docker(['compose', '-p', this.project, ...files, '--env-file', this.envFile, ...args]);
  }

  async up(): Promise<DockerResult> {
    return this.compose(['up', '--wait', '--wait-timeout', String(WAIT_SECONDS)]);
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
    rmSync(this.folder, { recursive: true, force: true });
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
