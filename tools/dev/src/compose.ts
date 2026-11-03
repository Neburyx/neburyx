import { devNull } from 'node:os';
import { join } from 'node:path';
import type { Environment } from './environments.js';
import type { Run, RunResult } from './exec.js';
import { SETTING_KEYS } from './settings.js';

export const PROJECT = 'neburyx-dev';
const WAIT_SECONDS = 600;

export interface GraphService {
  readonly service: string;
  readonly loader: string;
  readonly sourceId: string;
}

export const DEMO_GRAPHS: readonly GraphService[] = [
  { service: 'demo-banking-graph', loader: 'load-banking', sourceId: 'banking-demo' },
  { service: 'demo-insurance-graph', loader: 'load-insurance', sourceId: 'insurance-demo' },
];

export class Stopped extends Error {
  constructor() {
    super('stopped by the developer');
    this.name = 'Stopped';
  }
}

export class StepFailed extends Error {
  constructor(step: string, detail = '') {
    super(`${step} failed${detail === '' ? '' : `: ${detail}`}`);
    this.name = 'StepFailed';
  }
}

/** The compose file requires every setting to be non-empty, but removing a project needs none of their values. */
const NOT_USED = 'not-used';
const LOOPBACK_PORT = /^127\.0\.0\.1:(\d{1,5})$/;

export class Compose {
  constructor(
    private readonly run: Run,
    private readonly root: string,
    private readonly environment: Environment,
    private readonly signal?: AbortSignal,
  ) {}

  private args(rest: string[], envFile: boolean): string[] {
    return ['compose', '-p', PROJECT, '--env-file', envFile ? join(this.root, '.env') : devNull, '-f', join(this.root, 'deploy/demo/compose.yaml'), '-f', join(this.root, 'deploy/demo/compose.dev.yaml'), ...rest];
  }

  private checkStopped(): void {
    if (this.signal?.aborted === true) throw new Stopped();
  }

  private async docker(rest: string[], show = false, envFile = true): Promise<RunResult> {
    this.checkStopped();
    const environment = envFile ? this.environment : { ...this.environment, ...Object.fromEntries(SETTING_KEYS.map((key) => [key, NOT_USED])) };
    const result = await this.run('docker', this.args(rest, envFile), { cwd: this.root, env: environment, show, ...(this.signal === undefined ? {} : { signal: this.signal }) });
    this.checkStopped();
    return result;
  }

  async build(service: string): Promise<void> {
    const result = await this.docker(['build', service], true);
    if (result.code !== 0) throw new StepFailed(`building the image of ${service}`);
  }

  async upHealthy(services: readonly string[]): Promise<void> {
    const result = await this.docker(['up', '-d', '--wait', '--wait-timeout', String(WAIT_SECONDS), ...services], true);
    if (result.code !== 0) throw new StepFailed(`starting ${services.join(', ')}`);
  }

  async runLoader(loader: string): Promise<void> {
    const result = await this.docker(['run', '-T', '--rm', '--no-deps', loader], true);
    if (result.code !== 0) throw new StepFailed(`the loader ${loader}`, `exit code ${result.code}`);
  }

  async port(service: string, containerPort: number): Promise<number> {
    const result = await this.docker(['port', service, String(containerPort)]);
    const match = LOOPBACK_PORT.exec(result.stdout.trim());
    if (result.code !== 0 || match?.[1] === undefined) throw new StepFailed(`finding the published port of ${service}`, 'it is not published on 127.0.0.1');
    return Number(match[1]);
  }

  async down(): Promise<void> {
    const result = await this.docker(['down', '-v', '--remove-orphans'], true, false);
    if (result.code !== 0) throw new StepFailed('removing the containers and volumes');
  }
}
