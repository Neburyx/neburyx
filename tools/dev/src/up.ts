import { join } from 'node:path';
import { Compose, DEMO_GRAPHS, StepFailed, Stopped } from './compose.js';
import { apiEnvironment, baseEnvironment, dockerEnvironment, migrationEnvironment, webEnvironment } from './environments.js';
import type { Run } from './exec.js';
import { externalDatabase } from './external.js';
import { Lock, type LockOptions } from './lock.js';
import { formatSettings, generateSettings, invalidKeys, parseEnvFile, settingsOf, type Random, type Settings } from './settings.js';
import type { Supervision } from './supervisor.js';

export class SettingsInvalid extends Error {
  readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    super(`.env has missing or unusable settings: ${keys.join(', ')}; the file is left as it is`);
    this.name = 'SettingsInvalid';
    this.keys = keys;
  }
}

export interface Files {
  exists(path: string): boolean;
  read(path: string): string;
  write(path: string, text: string, mode: number): void;
  mkdir(path: string): void;
  remove(path: string): void;
}

export interface Dependencies {
  readonly root: string;
  readonly run: Run;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly random: Random;
  readonly files: Files;
  readonly nodePath: string;
  readonly freePort: () => Promise<number>;
  readonly supervise: (options: Supervision) => Promise<number>;
  readonly stopRequested: Promise<void>;
  readonly lock: Pick<LockOptions, 'folder' | 'alive' | 'beforeTakeover'>;
}

export const BUILDS: readonly { readonly name: string; readonly filter: string }[] = [
  { name: 'the demo graph tool', filter: '@neburyx/demo-graph' },
  { name: 'the contracts', filter: '@neburyx/contracts' },
  { name: 'the API', filter: '@neburyx/api' },
  { name: 'the web app', filter: '@neburyx/web' },
];

const LOCAL_APP_ROLE = 'neburyx_app';
const LOCAL_MIGRATION_ROLE = 'neburyx_migrate';
const LOCAL_DATABASE = 'neburyx';
const PACKS = 'banking-fraud,insurance-claims';

export function loadSettings(deps: Pick<Dependencies, 'root' | 'files' | 'random'>): Settings {
  const path = join(deps.root, '.env');
  if (!deps.files.exists(path)) {
    const created = generateSettings(deps.random);
    deps.files.write(path, formatSettings(created), 0o600);
    return created;
  }
  const values = parseEnvFile(deps.files.read(path));
  const invalid = invalidKeys(values);
  if (invalid.length > 0) throw new SettingsInvalid(invalid);
  return settingsOf(values);
}

function lockOptions(deps: Dependencies) {
  return { repository: deps.root, ...deps.lock };
}

export async function up(deps: Dependencies): Promise<number> {
  const lock = Lock.acquire(lockOptions(deps));
  const stopping = new AbortController();
  void deps.stopRequested.then(() => stopping.abort());
  try {
    const external = externalDatabase(deps.env);
    const settings = loadSettings(deps);
    const base = baseEnvironment(deps.env);
    const step = async (name: string, command: string, args: readonly string[], env = base, cwd = deps.root): Promise<void> => {
      if (stopping.signal.aborted) throw new Stopped();
      const result = await deps.run(command, args, { cwd, env, show: true, signal: stopping.signal });
      if (stopping.signal.aborted) throw new Stopped();
      if (result.code !== 0) throw new StepFailed(name, `exit code ${result.code}`);
    };

    for (const build of BUILDS) await step(`building ${build.name}`, 'pnpm', ['--filter', build.filter, 'build']);

    const compose = new Compose(deps.run, deps.root, dockerEnvironment(deps.env), stopping.signal);
    const [firstGraph] = DEMO_GRAPHS;
    if (firstGraph === undefined) throw new Error('no demo graph');
    await compose.build(firstGraph.loader);
    await compose.upHealthy([...(external === undefined ? ['db'] : []), ...DEMO_GRAPHS.map((graph) => graph.service)]);
    for (const graph of DEMO_GRAPHS) await compose.runLoader(graph.loader);

    const databasePort = external === undefined ? await compose.port('db', 5432) : 0;
    const addresses: string[] = [];
    for (const graph of DEMO_GRAPHS) addresses.push(`${graph.sourceId}=bolt://127.0.0.1:${await compose.port(graph.service, 7687)}`);

    const appUrl = external?.appUrl ?? `postgres://${LOCAL_APP_ROLE}:${settings.NEBURYX_DB_APP_PASSWORD}@127.0.0.1:${databasePort}/${LOCAL_DATABASE}`;
    const migrationUrl = external?.migrationUrl ?? `postgres://${LOCAL_MIGRATION_ROLE}:${settings.NEBURYX_DB_MIGRATION_PASSWORD}@127.0.0.1:${databasePort}/${LOCAL_DATABASE}`;
    const appRole = external?.appRole ?? LOCAL_APP_ROLE;

    const devFolder = join(deps.root, '.dev');
    const mappingPath = join(devFolder, 'neburyx.yaml');
    deps.files.mkdir(devFolder);
    await step('writing the mapping', deps.nodePath, [join(deps.root, 'tools/demo-graph/dist/main.js'), 'combine', '--packs', PACKS, '--addresses', addresses.join(','), '--out', mappingPath]);
    await step('migrating the database', deps.nodePath, [join(deps.root, 'services/api/dist/cli.js'), 'migrate'], migrationEnvironment(base, migrationUrl, appRole));

    const apiPort = await deps.freePort();
    const webPort = await deps.freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    deps.out(`web app:  http://127.0.0.1:${webPort}\napi:      ${apiUrl}\nsources:  ${apiUrl}/v1/sources (both demo sources, synthetic; read-only is not verified on the Community demo servers)\nstop with Ctrl-C; remove the containers with pnpm dev:down`);

    const watchTsc = (name: string, folder: string) => ({ name, command: 'pnpm', args: ['exec', 'tsc', '-p', 'tsconfig.build.json', '--watch', '--preserveWatchOutput'], cwd: join(deps.root, folder), env: base });
    return await deps.supervise({
      children: [
        watchTsc('the contracts compiler', 'packages/contracts'),
        watchTsc('the API compiler', 'services/api'),
        { name: 'the web dev server', command: 'pnpm', args: ['exec', 'vite', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], cwd: join(deps.root, 'apps/web'), env: webEnvironment(base, apiUrl) },
      ],
      api: {
        name: 'the API',
        command: deps.nodePath,
        args: [join(deps.root, 'services/api/dist/main.js')],
        cwd: deps.root,
        env: apiEnvironment(base, { databaseUrl: appUrl, mappingPath, port: apiPort, webRoot: join(deps.root, 'apps/web/dist'), settings }),
        healthUrl: `${apiUrl}/healthz`,
        watch: [join(deps.root, 'services/api/dist'), join(deps.root, 'packages/contracts/dist')],
      },
      out: deps.out,
      onPids: (pids) => lock.setChildren(pids),
      stopRequested: deps.stopRequested,
    });
  } catch (error) {
    if (error instanceof Stopped) {
      deps.out('stopped; the containers keep running');
      return 0;
    }
    throw error;
  } finally {
    lock.release();
  }
}

export async function down(deps: Dependencies): Promise<number> {
  const lock = Lock.acquire(lockOptions(deps));
  try {
    await new Compose(deps.run, deps.root, dockerEnvironment(deps.env)).down();
    deps.files.remove(join(deps.root, '.dev'));
    deps.out('the development containers and volumes are removed; .env is kept');
    return 0;
  } finally {
    lock.release();
  }
}
