import { createHash } from 'node:crypto';
import { UsageError } from '../questions.js';

/** What a thread run is about, read from an external file: the source, the anchor, the type of the neighbours put in the view and the messages. The real file is private; the public repository holds a neutral example. */
export interface Manifest {
  readonly name: string;
  readonly sourceId: string;
  readonly anchor: { readonly entityType: string; readonly stableId: string };
  readonly neighbourType: string;
  readonly neighbours: number;
  /** When present, the view shows relationships: the anchor expanded to these types of neighbours, with the entities and relationships exactly as many as said. Absent, the view is the plain one (the anchor and its neighbours of one type, no relationship). */
  readonly edgesView?: { readonly neighbourTypes: readonly string[]; readonly entities: number; readonly relationships: number };
  readonly messages: readonly string[];
}

const MAX_MESSAGES = 40;
const MAX_NEIGHBOURS = 100;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 2000;

function edgesViewOf(value: unknown): Manifest['edgesView'] {
  if (value === undefined) return undefined;
  const object = isRecord(value) ? value : undefined;
  const types = object?.['neighbourTypes'];
  const entities = object?.['entities'];
  const relationships = object?.['relationships'];
  const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 1000;
  if (object === undefined || Object.keys(object).some((key) => !['neighbourTypes', 'entities', 'relationships'].includes(key))) throw new UsageError('the manifest field edgesView needs neighbourTypes, entities and relationships and nothing else');
  if (!Array.isArray(types) || types.length === 0 || types.length > 10 || !types.every(isText)) throw new UsageError('the manifest field edgesView.neighbourTypes is not a list of 1 to 10 texts');
  if (!whole(entities) || !whole(relationships)) throw new UsageError('the manifest fields edgesView.entities and edgesView.relationships are not whole numbers from 1 to 1000');
  return { neighbourTypes: types.filter(isText), entities, relationships };
}

/** Reads a manifest, refusing any shape it does not know; the message names the field and never holds a value. */
export function parseManifest(text: string): { readonly manifest: Manifest; readonly sha256: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError('the manifest is not JSON');
  }
  const object = isRecord(raw) ? raw : undefined;
  if (object === undefined) throw new UsageError('the manifest is not an object');
  const known = ['name', 'sourceId', 'anchor', 'neighbourType', 'neighbours', 'edgesView', 'messages'];
  const extra = Object.keys(object).filter((key) => !known.includes(key));
  if (extra.length > 0) throw new UsageError(`the manifest has a field it does not know: ${extra[0] ?? ''}`.slice(0, 80));
  const anchor = object['anchor'];
  const anchorObject = isRecord(anchor) ? anchor : undefined;
  const messages = object['messages'];
  const neighbours = object['neighbours'];
  if (!isText(object['name'])) throw new UsageError('the manifest field name is missing or not text');
  if (!isText(object['sourceId'])) throw new UsageError('the manifest field sourceId is missing or not text');
  if (anchorObject === undefined || !isText(anchorObject['entityType']) || !isText(anchorObject['stableId'])) throw new UsageError('the manifest field anchor needs entityType and stableId');
  if (Object.keys(anchorObject).some((key) => key !== 'entityType' && key !== 'stableId')) throw new UsageError('the manifest field anchor holds a field it does not know');
  if (!isText(object['neighbourType'])) throw new UsageError('the manifest field neighbourType is missing or not text');
  if (typeof neighbours !== 'number' || !Number.isInteger(neighbours) || neighbours < 1 || neighbours > MAX_NEIGHBOURS) throw new UsageError(`the manifest field neighbours is not a whole number from 1 to ${MAX_NEIGHBOURS}`);
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES || !messages.every(isText)) throw new UsageError(`the manifest field messages is not a list of 1 to ${MAX_MESSAGES} texts`);
  const edgesView = edgesViewOf(object['edgesView']);
  return {
    manifest: { name: object['name'], sourceId: object['sourceId'], anchor: { entityType: anchorObject['entityType'], stableId: anchorObject['stableId'] }, neighbourType: object['neighbourType'], neighbours, ...(edgesView === undefined ? {} : { edgesView }), messages: messages.filter(isText) },
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
