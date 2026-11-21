const GATES = ['v0.1', 'ask-preview'] as const;
export type Gate = (typeof GATES)[number];

export interface RunOptions {
  readonly recordDir: string;
  /** The release gate whose checks run; gate 1 when none is given. */
  readonly gate: Gate;
  readonly dryRun: boolean;
  /** A product image that is already built; the demo install then does not time a build. */
  readonly image?: string;
}

export type ParsedArgs = { readonly kind: 'run'; readonly options: RunOptions } | { readonly kind: 'usage-error'; readonly message: string };

export const USAGE = 'usage: pnpm check:release --record-dir <folder outside this repository> [--dry-run] [--image <name>] [--gate v0.1|ask-preview]';

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let recordDir: string | undefined;
  let dryRun = false;
  let image: string | undefined;
  let gate: Gate = 'v0.1';
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--image') {
      image = argv[index + 1];
      index += 1;
      if (image === undefined || image.startsWith('--')) return { kind: 'usage-error', message: '--image needs an image name' };
    } else if (arg === '--gate') {
      const named = argv[index + 1];
      index += 1;
      const found = GATES.find((candidate) => candidate === named);
      if (found === undefined) return { kind: 'usage-error', message: `--gate must be one of ${GATES.join(', ')}` };
      gate = found;
    } else if (arg === '--record-dir') {
      recordDir = argv[index + 1];
      index += 1;
      if (recordDir === undefined || recordDir.startsWith('--')) return { kind: 'usage-error', message: '--record-dir needs a folder' };
    } else {
      return { kind: 'usage-error', message: `unknown option ${arg ?? ''}` };
    }
  }
  if (recordDir === undefined) return { kind: 'usage-error', message: '--record-dir is required' };
  return { kind: 'run', options: { recordDir, gate, dryRun, ...(image === undefined ? {} : { image }) } };
}
