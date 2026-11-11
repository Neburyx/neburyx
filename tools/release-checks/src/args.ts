export interface RunOptions {
  readonly recordDir: string;
  readonly dryRun: boolean;
  /** A product image that is already built; the demo install then does not time a build. */
  readonly image?: string;
}

export type ParsedArgs = { readonly kind: 'run'; readonly options: RunOptions } | { readonly kind: 'usage-error'; readonly message: string };

export const USAGE = 'usage: pnpm check:release --record-dir <folder outside this repository> [--dry-run] [--image <name>]';

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let recordDir: string | undefined;
  let dryRun = false;
  let image: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--image') {
      image = argv[index + 1];
      index += 1;
      if (image === undefined || image.startsWith('--')) return { kind: 'usage-error', message: '--image needs an image name' };
    } else if (arg === '--record-dir') {
      recordDir = argv[index + 1];
      index += 1;
      if (recordDir === undefined || recordDir.startsWith('--')) return { kind: 'usage-error', message: '--record-dir needs a folder' };
    } else {
      return { kind: 'usage-error', message: `unknown option ${arg ?? ''}` };
    }
  }
  if (recordDir === undefined) return { kind: 'usage-error', message: '--record-dir is required' };
  return { kind: 'run', options: { recordDir, dryRun, ...(image === undefined ? {} : { image }) } };
}
