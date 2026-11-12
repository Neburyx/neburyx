import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IMAGE_FILES = ['pnpm-lock.yaml', 'package.json', '.nvmrc'];
const IMAGE_FOLDERS = ['deploy/', '.github/workflows/'];
const QUICKSTART_FILES = ['README.md', 'services/api/src/compose/readme-quickstart.compose.test.ts', 'services/api/src/compose/stack.ts', 'services/api/vitest.compose.config.ts'];
const QUICKSTART_FOLDERS = ['deploy/'];
const ZERO_REVISION = /^0+$/;
const USAGE = 'usage: changed-paths.mjs --base <revision> --head <revision>';

const touches = (paths, files, folders) => paths.some((path) => files.includes(path) || folders.some((folder) => path.startsWith(folder)));

/** Which slow steps a list of changed files calls for; both are true when the list could not be read, never false by default. */
export function classify(paths) {
  if (paths === undefined) return { image: true, quickstart: true };
  return { image: touches(paths, IMAGE_FILES, IMAGE_FOLDERS), quickstart: touches(paths, QUICKSTART_FILES, QUICKSTART_FOLDERS) };
}

/** The paths between two revisions (a rename lists the old path and the new one, so a file moved out of a watched folder still counts), or undefined when there is no usable base (a new branch, a forced push that dropped it) or git cannot say. */
export function changedBetween(base, head, exec) {
  if (base === undefined || base === '' || ZERO_REVISION.test(base) || head === undefined || head === '') return undefined;
  const result = exec('git', ['diff', '--name-only', '--no-renames', '-z', base, head]);
  if (result.status !== 0) return undefined;
  return result.stdout.split('\0').filter((path) => path !== '');
}

export function run(argv, exec, write, report = (text) => process.stderr.write(text)) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) options.set(argv[index], argv[index + 1]);
  if (argv.length % 2 !== 0 || [...options.keys()].some((key) => key !== '--base' && key !== '--head')) {
    report(`${USAGE}\n`);
    return 2;
  }
  const { image, quickstart } = classify(changedBetween(options.get('--base'), options.get('--head'), exec));
  write(`image=${image}\nquickstart=${quickstart}\n`);
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const exec = (tool, args) => {
    const result = spawnSync(tool, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { status: result.status ?? 1, stdout: result.stdout ?? '' };
  };
  process.exitCode = run(process.argv.slice(2), exec, (text) => process.stdout.write(text));
}
