import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadDevConfig } from './config.js';
import { apiEnvironment, baseEnvironment, migrationEnvironment, webEnvironment } from './environments.js';
import type { Run } from './exec.js';
import { externalDatabase } from './external.js';
import type { Files } from './files.js';
import { Lock, type LockOptions } from './lock.js';
import { devMapping } from './mapping.js';
import { StepFailed, Stopped } from './steps.js';
import type { Supervision } from './supervisor.js';

export interface Dependencies {
  readonly root: string;
  readonly run: Run;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly random: (bytes: number) => Buffer;
  readonly files: Files;
  readonly nodePath: string;
  readonly freePort: () => Promise<number>;
  readonly supervise: (options: Supervision) => Promise<number>;
  readonly stopRequested: Promise<void>;
  readonly lock: Pick<LockOptions, 'folder' | 'alive' | 'beforeTakeover'>;
}

export const BUILDS: readonly { readonly name: string; readonly filter: string }[] = [
  { name: 'the contracts', filter: '@neburyx/contracts' },
  { name: 'the API', filter: '@neburyx/api' },
  { name: 'the web app', filter: '@neburyx/web' },
];

const CURSOR_KEY_BYTES = 32;

/**
 * Runs the app against the Neo4j and Postgres the developer's settings file names. It starts no container and calls no container
 * tool. The settings are checked first: when any is missing or unusable nothing is locked, built or started.
 */
export async function up(deps: Dependencies): Promise<number> {
  const config = loadDevConfig(deps.env, deps.files);
  const own = devMapping(config, deps.files);
  const database = externalDatabase(config);

  const lock = Lock.acquire({ repository: deps.root, ...deps.lock });
  const stopping = new AbortController();
  void deps.stopRequested.then(() => stopping.abort());
  try {
    const base = baseEnvironment(deps.env);
    const step = async (name: string, command: string, args: readonly string[], env = base, cwd = deps.root): Promise<void> => {
      if (stopping.signal.aborted) throw new Stopped();
      const result = await deps.run(command, args, { cwd, env, show: true, signal: stopping.signal });
      if (stopping.signal.aborted) throw new Stopped();
      if (result.code !== 0) throw new StepFailed(name, `exit code ${result.code}`);
    };

    for (const build of BUILDS) await step(`building ${build.name}`, 'pnpm', ['--filter', build.filter, 'build']);
    await step('migrating the database', deps.nodePath, [join(deps.root, 'services/api/dist/cli.js'), 'migrate'], migrationEnvironment(base, database.migrationUrl, database.appRole));

    const apiPort = await deps.freePort();
    const webPort = await deps.freePort();
    const apiUrl = `http://127.0.0.1:${apiPort}`;
    deps.out(`web app:  http://127.0.0.1:${webPort}\napi:      ${apiUrl}\nsources:  ${apiUrl}/v1/sources (the sources of the mapping you chose; this command does not check that their logins are read-only)\nstop with Ctrl-C`);

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
        env: apiEnvironment(base, { databaseUrl: database.appUrl, mappingPath: own.mappingPath, port: apiPort, webRoot: join(deps.root, 'apps/web/dist'), cursorKey: deps.random(CURSOR_KEY_BYTES).toString('base64'), exportDirectory: join(tmpdir(), `neburyx-dev-exports-${apiPort}`), sourceLogins: own.logins }),
        healthUrl: `${apiUrl}/healthz`,
        watch: [join(deps.root, 'services/api/dist'), join(deps.root, 'packages/contracts/dist')],
      },
      out: deps.out,
      onPids: (pids) => lock.setChildren(pids),
      stopRequested: deps.stopRequested,
    });
  } catch (error) {
    if (error instanceof Stopped) {
      deps.out('stopped');
      return 0;
    }
    throw error;
  } finally {
    lock.release();
  }
}
