import { posix } from 'node:path';

const EXTENSION = /\.(?:[cm]?[jt]sx?)$/;
const SUFFIX = /[?#].*$/;

export interface Resolved {
  /** Repo-relative path without extension and without a trailing /index. */
  readonly path: string;
  /** `file`: the specifier has an extension. `index`: it ends in /index, with or without an extension. `bare`: no extension, so a file or a folder. */
  readonly kind: 'file' | 'index' | 'bare';
}

/** Where a relative specifier points; undefined for a package name. A query or fragment on the specifier is ignored. */
export function resolveRelative(fromFile: string, specifier: string): Resolved | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier.replace(SUFFIX, '')));
  const withoutExtension = joined.replace(EXTENSION, '');
  const kind = /\/index$/.test(withoutExtension) ? 'index' : withoutExtension === joined ? 'bare' : 'file';
  return { path: withoutExtension.replace(/\/index$/, ''), kind };
}

/** Inside the directory, or the directory itself when the specifier can name a directory; a sibling file of the same name is not. */
export function isInsideDirectory(resolved: Resolved, directory: string): boolean {
  return resolved.path.startsWith(`${directory}/`) || (resolved.path === directory && resolved.kind !== 'file');
}

/** The file with this module path, but not a folder of the same name with an index file. */
export function isFileModule(resolved: Resolved, modulePath: string): boolean {
  return resolved.path === modulePath && resolved.kind !== 'index';
}

export function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

export function withoutExtension(path: string): string {
  return path.replace(EXTENSION, '');
}
