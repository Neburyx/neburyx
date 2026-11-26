import { createHash } from 'node:crypto';
import { ASK_ENTITY_TEXT_MAX_LENGTH, ASK_FOLDER_LIMITS, ASK_INTENT_NAME, ASK_SAVED_PATTERN_INTENT, checkIntentQuery, mayUseMaskedProperty, type AskFolder, type AskIntent } from '@neburyx/contracts';
import { AppError } from '../errors.js';
import type { NormalizeModel } from './normalize/model.js';
import type { Rendered } from './render.js';
import type { Params } from './types.js';

export const FILE_QUERY_ID = 'file-query';

/**
 * Where the gate gets the query of a file query and how it checks it: the intent of the source's Ask folder by the request's source and the intent's name (the folder is read at each run, because it exists only
 * after the extension is configured), and the checker that refuses what the clause allowlist does not allow. The checker is a seam so that a test can show the read transaction as the last defence.
 */
export interface FileQueryDeps {
  readonly intent: (sourceId: string, name: string) => AskIntent | undefined;
  readonly check: (input: { readonly intent: string; readonly query: string; readonly parameters: readonly string[] }) => readonly string[];
}

/** The lookup and the checker a gate uses for the folder the extension loaded: read at each run, and the one checker the loader uses. */
export function fileQueryDepsOf(folder: () => AskFolder | undefined, check: FileQueryDeps['check'] = checkIntentQuery): FileQueryDeps {
  return { intent: (sourceId, name) => folder()?.intent(sourceId, name), check };
}

const refused = (reason: 'file-query-text' | 'file-query-intent' | 'file-query-values' | 'file-query-masked'): AppError => new AppError('INVALID_REQUEST', { reason });

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The query intent a request names, or the refusal: an unknown name, a source with no folder, another source's intent (the lookup is by the request's source), the saved-pattern intent and a template intent are not file queries. */
function fileQueryOf(deps: FileQueryDeps | undefined, sourceId: string, name: unknown): Extract<AskIntent, { kind: 'query' }> {
  if (deps === undefined || typeof name !== 'string' || !ASK_INTENT_NAME.test(name) || name === ASK_SAVED_PATTERN_INTENT) throw refused('file-query-intent');
  const found = deps.intent(sourceId, name);
  if (found === undefined || found.kind !== 'query' || found.name !== name) throw refused('file-query-intent');
  return found;
}

/** The values of a request as text, exactly the intent's parameters: a name more or less, a value that is not text of 1 to 256 characters, or too many values is refused. */
function valuesOf(intent: Extract<AskIntent, { kind: 'query' }>, given: unknown): Readonly<Record<string, string>> {
  if (typeof given !== 'object' || given === null || Array.isArray(given)) throw refused('file-query-values');
  const entries = Object.entries(given);
  if (entries.length > ASK_FOLDER_LIMITS.parameters || entries.length !== intent.parameters.length) throw refused('file-query-values');
  const values: Record<string, string> = Object.create(null);
  for (const name of intent.parameters) {
    const value: unknown = Object.hasOwn(given, name) ? Object.getOwnPropertyDescriptor(given, name)?.value : undefined;
    if (typeof value !== 'string' || value.length < 1 || [...value].length > ASK_ENTITY_TEXT_MAX_LENGTH) throw refused('file-query-values');
    values[name] = value;
  }
  return values;
}

/**
 * The statement and the parameters of a file query: the text of the folder, checked again here (the clause allowlist and the names of its parameters, and that its hash is the one the folder holds), and the values
 * of the request as its only parameters. Nothing of the request is part of the text.
 */
export function renderFileQuery(deps: FileQueryDeps | undefined, sourceId: string, params: Params): Rendered {
  const intent = fileQueryOf(deps, sourceId, params['intent']);
  if (deps === undefined) throw refused('file-query-intent');
  if (sha256(intent.query.text) !== intent.query.sha256 || deps.check({ intent: intent.name, query: intent.query.text, parameters: intent.parameters }).length > 0) throw refused('file-query-text');
  return { cypher: intent.query.text, parameters: valuesOf(intent, params['values']) };
}

/**
 * A masked field is not an oracle: while masking is asked, a file query that may use a property the mapping marks `pii`, on any entity type of the source, is refused. The text does not say which type a variable has,
 * so the names of every type count.
 */
export function refuseMaskedFileQuery(query: string, model: NormalizeModel): void {
  const properties = [...model.entitiesByType.values()].flatMap((entity) => entity.pii);
  if (mayUseMaskedProperty(query, properties)) throw refused('file-query-masked');
}

/**
 * What the audit event of a file-query run says of it: the intent's name and the hash the folder holds for its query, each only when the request names an intent of the source's folder that is a query (a name the folder does not hold,
 * or a text that is not an intent name, is left out, so a string of the request is never written). Never a value, a query text or a row.
 */
export type FileQueryAuditDetail = { readonly fileQuery: { readonly intent: string; readonly queryHash: string } };

export function fileQueryAuditDetail(deps: FileQueryDeps | undefined, sourceId: string, params: unknown): FileQueryAuditDetail | undefined {
  const name: unknown = typeof params === 'object' && params !== null ? Object.getOwnPropertyDescriptor(params, 'intent')?.value : undefined;
  if (deps === undefined || typeof name !== 'string' || !ASK_INTENT_NAME.test(name)) return undefined;
  const found = deps.intent(sourceId, name);
  return found === undefined || found.kind !== 'query' ? undefined : { fileQuery: { intent: found.name, queryHash: found.query.sha256 } };
}
