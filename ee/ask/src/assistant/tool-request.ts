import { ASK_ENTITY_TEXT_MAX_LENGTH, hasDuplicateKeys } from '@neburyx/contracts';
import type { Tool, ToolRegistry } from './tool-registry.js';

export interface ToolRequest {
  readonly tool: Tool;
  readonly values: Readonly<Record<string, string>>;
}

export type ToolRequestRead =
  | { readonly ok: true; readonly request: ToolRequest }
  /** `unavailable` for a tool of the registry whose template can no longer run; every other reply that does not fit is `malformed`. */
  | { readonly ok: false; readonly reason: 'malformed' | 'unavailable' };

const MALFORMED: ToolRequestRead = { ok: false, reason: 'malformed' };
const REQUEST_MAX_CHARACTERS = 4_000;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const hasExactly = (data: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const own = Object.keys(data);
  return own.length === keys.length && keys.every((key) => key in data);
};

function valuesOf(data: unknown, parameters: readonly string[]): Readonly<Record<string, string>> | undefined {
  if (!isRecord(data) || !hasExactly(data, parameters)) return undefined;
  const values: Record<string, string> = {};
  for (const name of parameters) {
    const value = data[name];
    if (typeof value !== 'string' || value.trim() === '' || value.length > ASK_ENTITY_TEXT_MAX_LENGTH) return undefined;
    values[name] = value;
  }
  return values;
}

/**
 * Reads the text of a reply as a request for a tool, strictly: exactly one JSON object with a `tool` that is a name of the registry and `values` that are exactly the tool's parameters, each a non-empty text;
 * no other member, no duplicate key and no text around it. The values are never query text: the step that runs the tool gives them to the tool as parameters only.
 */
export function readToolRequest(text: string, registry: ToolRegistry): ToolRequestRead {
  if (text.length > REQUEST_MAX_CHARACTERS) return MALFORMED;
  let data: unknown;
  try {
    if (hasDuplicateKeys(text)) return MALFORMED;
    data = JSON.parse(text);
  } catch {
    return MALFORMED;
  }
  if (!isRecord(data) || !hasExactly(data, ['tool', 'values'])) return MALFORMED;
  const name = data['tool'];
  const tool = typeof name === 'string' ? registry.find(name) : undefined;
  if (tool === undefined) return MALFORMED;
  if (!tool.available) return { ok: false, reason: 'unavailable' };
  const values = valuesOf(data['values'], tool.parameters);
  return values === undefined ? MALFORMED : { ok: true, request: { tool, values } };
}

export type ToolReplyDecision = 'request' | 'repeat' | 'malformed' | 'unavailable';

/**
 * What the loop does with a reply that was read: a request is run; a malformed one is asked for once more with a fixed note, and only while the calls limit leaves room for the answer too; a second malformed
 * reply, or one with no room, ends the turn with the fixed sentence; an unavailable tool is the fixed unavailable sentence and is not repeated.
 */
export function decideToolReply(read: ToolRequestRead, turn: { readonly callsUsed: number; readonly maxCalls: number; readonly repeated: boolean }): ToolReplyDecision {
  if (read.ok) return 'request';
  if (read.reason === 'unavailable') return 'unavailable';
  return !turn.repeated && turn.callsUsed + 1 < turn.maxCalls ? 'repeat' : 'malformed';
}
