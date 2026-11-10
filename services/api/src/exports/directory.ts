import { accessSync, constants, mkdirSync, statSync } from 'node:fs';

/** Group and others get nothing on the export directory or on a file in it. */
export const EXPORT_DIRECTORY_MODE = 0o700;
export const EXPORT_FILE_MODE = 0o600;
const OTHERS_AND_GROUP = 0o077;

/** Creates the export directory when it is missing (mode 0700) and checks it is a directory this process can write that no other account can read; answers the problem, or `undefined` when it is fit. */
export function exportDirectoryProblem(directory: string): string | undefined {
  try {
    mkdirSync(directory, { recursive: true, mode: EXPORT_DIRECTORY_MODE });
    const stat = statSync(directory);
    if (!stat.isDirectory()) return 'is not a directory';
    if ((stat.mode & OTHERS_AND_GROUP) !== 0) return 'is readable by other accounts; its mode must be 0700';
    accessSync(directory, constants.R_OK | constants.W_OK | constants.X_OK);
    return undefined;
  } catch {
    return 'cannot be created or written by this process';
  }
}
