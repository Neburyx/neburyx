import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

export interface LoadOptions {
  readonly include: readonly string[];
  readonly exclude?: readonly string[];
}

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['node_modules', 'dist', 'dist-ux', '.git']);

function walk(root: string, relative: string, exclude: readonly string[], out: SourceFile[]): void {
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = relative === '.' ? entry.name : posix.join(relative, entry.name);
    if (exclude.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) continue;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(root, path, exclude, out);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      out.push({ path, text: readFileSync(join(root, path), 'utf8') });
    }
  }
}

function isRealDirectory(root: string, directory: string): boolean {
  try {
    return lstatSync(join(root, directory)).isDirectory();
  } catch (error) {
    // a requested directory the repository does not have is skipped; anything else (no permission, say) is a failed scan
    if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Reads the source files under the given directories of a repository root, as repo-relative posix paths.
 * A requested directory the repository does not have, or that is a symbolic link, is skipped; any other failure is thrown.
 * Symbolic links inside the directories are not followed.
 */
export function loadTree(root: string, options: LoadOptions): SourceFile[] {
  const files: SourceFile[] = [];
  for (const directory of options.include) {
    if (isRealDirectory(root, directory)) walk(root, directory, options.exclude ?? [], files);
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
