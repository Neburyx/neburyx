import { createHash } from 'node:crypto';
import { UsageError } from '../questions.js';

/** What a thread run is about, read from an external file: the source, the anchor, the type of the neighbours put in the view and the messages. The real file is private; the public repository holds a neutral example. */
export interface Manifest {
  readonly name: string;
  readonly sourceId: string;
  readonly anchor: { readonly entityType: string; readonly stableId: string };
  readonly neighbourType: string;
  readonly neighbours: number;
  readonly messages: readonly string[];
}

const MAX_MESSAGES = 40;
const MAX_NEIGHBOURS = 100;

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 2000;

/** Reads a manifest, refusing any shape it does not know; the message names the field and never holds a value. */
export function parseManifest(text: string): { readonly manifest: Manifest; readonly sha256: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new UsageError('the manifest is not JSON');
  }
  const object = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
  if (object === undefined) throw new UsageError('the manifest is not an object');
  const known = ['name', 'sourceId', 'anchor', 'neighbourType', 'neighbours', 'messages'];
  const extra = Object.keys(object).filter((key) => !known.includes(key));
  if (extra.length > 0) throw new UsageError(`the manifest has a field it does not know: ${extra[0] ?? ''}`.slice(0, 80));
  const anchor = object['anchor'];
  const anchorObject = typeof anchor === 'object' && anchor !== null ? (anchor as Record<string, unknown>) : undefined;
  const messages = object['messages'];
  const neighbours = object['neighbours'];
  if (!isText(object['name'])) throw new UsageError('the manifest field name is missing or not text');
  if (!isText(object['sourceId'])) throw new UsageError('the manifest field sourceId is missing or not text');
  if (anchorObject === undefined || !isText(anchorObject['entityType']) || !isText(anchorObject['stableId'])) throw new UsageError('the manifest field anchor needs entityType and stableId');
  if (!isText(object['neighbourType'])) throw new UsageError('the manifest field neighbourType is missing or not text');
  if (typeof neighbours !== 'number' || !Number.isInteger(neighbours) || neighbours < 1 || neighbours > MAX_NEIGHBOURS) throw new UsageError(`the manifest field neighbours is not a whole number from 1 to ${MAX_NEIGHBOURS}`);
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES || !messages.every(isText)) throw new UsageError(`the manifest field messages is not a list of 1 to ${MAX_MESSAGES} texts`);
  return {
    manifest: { name: object['name'], sourceId: object['sourceId'], anchor: { entityType: anchorObject['entityType'], stableId: anchorObject['stableId'] }, neighbourType: object['neighbourType'], neighbours, messages: [...(messages as string[])] },
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
}
