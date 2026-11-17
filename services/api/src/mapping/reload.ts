import { isDeepStrictEqual } from 'node:util';
import { MappingError } from './diagnostics.js';
import { loadMappingFile } from './load.js';
import type { MappingModel, SourceModel } from './model.js';

export type ReloadStep =
  | { readonly kind: 'applied'; readonly mapping: MappingModel; readonly added: readonly string[]; readonly changed: readonly string[]; readonly removed: readonly string[] }
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'refused'; readonly message: string };

export interface ReloadInput {
  readonly path: string;
  readonly held: MappingModel;
  /** The enterprise extension checked its files at start against the source IDs and budgets, so a change to either waits for a restart. */
  readonly extensionLoaded: boolean;
}

const RESTART = 'it applies after a restart';

function connectionProblem(before: SourceModel, after: SourceModel): string | undefined {
  if (before.uri !== after.uri) return `the address of source ${after.id} changed`;
  if (before.database !== after.database) return `the database of source ${after.id} changed`;
  if (before.auth.usernameEnv !== after.auth.usernameEnv || before.auth.passwordEnv !== after.auth.passwordEnv) return `the names of the credentials of source ${after.id} changed`;
  return undefined;
}

/**
 * Reads the mapping file again, as at start, and says what a reload would do with it: refuse it (an invalid file; a change that applies only after a restart: the `ai` section,
 * the connection of a source the process already holds, and, with the enterprise extension loaded, the set of sources or a budget), find it the same as the held mapping, or accept it.
 * Nothing is replaced here; the answer carries the new mapping for the caller to swap in.
 */
export function reloadStep(input: ReloadInput): ReloadStep {
  let next: MappingModel;
  try {
    next = loadMappingFile(input.path);
  } catch (error) {
    if (!(error instanceof MappingError)) throw error;
    return { kind: 'refused', message: error.message };
  }
  const held = input.held;
  if (!isDeepStrictEqual(held.ai, next.ai)) return { kind: 'refused', message: `the ai section changed: ${RESTART}` };

  const before = new Map(held.sources.map((source) => [source.id, source]));
  const after = new Map(next.sources.map((source) => [source.id, source]));
  for (const [id, source] of after) {
    const old = before.get(id);
    const problem = old === undefined ? undefined : connectionProblem(old, source);
    if (problem !== undefined) return { kind: 'refused', message: `${problem}: ${RESTART}` };
  }
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  const changed = [...after.keys()].filter((id) => before.has(id) && before.get(id)?.configHash !== after.get(id)?.configHash);
  if (input.extensionLoaded) {
    const budgetsChanged = changed.filter((id) => !isDeepStrictEqual(before.get(id)?.budgets, after.get(id)?.budgets));
    if (added.length > 0 || removed.length > 0 || budgetsChanged.length > 0) {
      return { kind: 'refused', message: `with the enterprise extension loaded, a change to the set of sources or to a budget applies after a restart (${[...added, ...removed, ...budgetsChanged].join(', ')})` };
    }
  }
  const retentionChanged = !isDeepStrictEqual(held.retention, next.retention);
  if (added.length === 0 && removed.length === 0 && changed.length === 0 && !retentionChanged) return { kind: 'unchanged' };
  return { kind: 'applied', mapping: next, added, changed, removed };
}
