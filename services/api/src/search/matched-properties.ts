import type { GraphNode } from '@neburyx/contracts';
import { integerCandidateOf, type TaggedInteger } from '../gate/templates/stable-id.js';
import type { SearchTarget } from '../gate/templates/search-exact.js';

/** Exact equality with the integer: a tagged integer is its decimal text, and a number is compared as the exact integer it holds, never as its rounded decimal text. */
function holdsInteger(value: unknown, integer: TaggedInteger): boolean {
  if (typeof value === 'string') return value === integer.value;
  return typeof value === 'number' && Number.isInteger(value) && BigInt(value) === BigInt(integer.value);
}

/**
 * The properties of a related record that hold the typed text, worked out from the redacted node and the targets of the request, with the same equality the executed branch used: the whole
 * text as stored, or for a `value` target the canonical integer the text can be. Only a property that is a target of this request on the record's type and was not returned masked is named,
 * so a personal-data property never named in a masked search (it is not a target) and a mask that happens to equal the text never counts.
 */
export function matchedPropertiesOf(node: GraphNode, targets: readonly SearchTarget[], text: string): string[] {
  const integer = integerCandidateOf(text);
  return targets
    .filter((target) => target.entityType === node.ref.entityType)
    .filter((target) => {
      const property = node.properties.find((candidate) => candidate.key === target.property);
      if (property === undefined || property.masked) return false;
      if (property.dataClass === 'text') return property.value === text;
      return target.match === 'value' && property.dataClass === 'number' && integer !== null && holdsInteger(property.value, integer);
    })
    .map((target) => target.property);
}
