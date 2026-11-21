import type { ExecuteCall, ExecuteOutcome } from '../gate/executor.js';
import type { MappingModel } from '../mapping/model.js';
import { plainNode } from './entity-fixtures.js';

type Respond = (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome> | undefined;

/**
 * The answer of a scripted source to the batched read of elements, which is how a value the person wrote is looked up: it holds the elements of the mapping's types for every id asked for (the id of a written value is one
 * the case chose), unless the case names the elements it holds (`held`, as `type/id`) so that a value of another type or one that does not exist can be shown. `own` builds the node of an element the rig knows with
 * its own content (the widgets the view holds, with their names). Any other read is the case's own (`respond`).
 */
export function lookupAnswer(call: ExecuteCall, mapping: MappingModel, respond: Respond | undefined, held?: readonly string[], own?: (entityType: string, id: string) => Record<string, unknown> | undefined): ExecuteOutcome | Promise<ExecuteOutcome> | undefined {
  const refs = call.parameters['refs'];
  if (call.templateId !== 'entity-load-many' || !Array.isArray(refs)) return respond?.(call);
  const list = refs as readonly { readonly stableId: string; readonly entityType?: string }[];
  const entityType = String(call.parameters['entityType'] ?? list[0]?.entityType);
  const entity = mapping.sources.flatMap((source) => source.entities).find((candidate) => candidate.type === entityType);
  if (entity === undefined) return { status: 'rows', rows: [] };
  return { status: 'rows', rows: list.flatMap((entry, i) => (held === undefined || held.includes(`${entityType}/${entry.stableId}`) ? [{ i, dup: false, n: own?.(entityType, entry.stableId) ?? plainNode([entity.label], { [entity.stableId]: entry.stableId }, `4:s:${entry.stableId}`) }] : [])) };
}
