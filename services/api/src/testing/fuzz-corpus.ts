import fc from 'fast-check';

/** Fixed for every fuzz file: a failing run prints this seed and the shrunk input, and the same seed replays it. */
export const FUZZ_SEED = 5017;
export const FUZZ_RUNS = 120;

export const fuzzParams = (runs = FUZZ_RUNS): fc.Parameters<unknown> => ({ seed: FUZZ_SEED, numRuns: runs, verbose: 0 });

/** Text that tries to become part of a statement. */
export const CYPHER_FRAGMENTS: readonly string[] = [
  "' RETURN 1 //",
  '" OR 1=1 --',
  '`) DETACH DELETE n //',
  '}) RETURN n UNION MATCH (m) RETURN m //',
  'MATCH (n) RETURN n',
  'CALL dbms.components()',
  'LOAD CSV FROM "file:///etc/passwd" AS l RETURN l',
  '$text',
  '$limit + 1',
  '$branchEntityTypes[0]',
  '@entity(kind)',
  '@label',
  '{marker}',
  '/* x */ MATCH (n) //',
  '\\u0027; DROP DATABASE neo4j',
  'Widget`) MATCH (x',
  'a\nMATCH (n) DELETE n',
  '${process.exit()}',
  '%s%n',
];

/** Fragments a template itself holds, so finding one in a statement shows nothing: the closed set is what proves such a request wrote no statement of its own. */
export const TEMPLATE_NATIVE: readonly string[] = ['$text', '$limit + 1', '$branchEntityTypes[0]', 'RANGE', 'TEXT'];

export const UNICODE_SAMPLES: readonly string[] = ['\u0000', 'a\u0000b', '‮', 'é́́', '😀', '﻿', '  ', '\u0085', '\ud800', '\udfff', 'Å', '٣', '​‍'];

/** A string that is none of `names`. */
export const hostileText = (names: ReadonlySet<string>): fc.Arbitrary<string> =>
  fc
    .oneof(
      fc.constantFrom(...CYPHER_FRAGMENTS),
      fc.constantFrom(...UNICODE_SAMPLES),
      fc.string({ unit: 'binary', maxLength: 60 }),
      fc.string({ unit: 'grapheme', maxLength: 40 }),
      fc.tuple(fc.constantFrom(...CYPHER_FRAGMENTS), fc.constantFrom(...names)).map(([fragment, name]) => `${name}${fragment}`),
      fc.constantFrom(...names).map((name) => name.toUpperCase()),
      fc.constantFrom(...names).map((name) => ` ${name} `),
    )
    .filter((text) => !names.has(text));

/** JSON values of the wrong type for a text field. */
export const wrongType: fc.Arbitrary<unknown> = fc.oneof(fc.constant(null), fc.integer(), fc.double(), fc.boolean(), fc.array(fc.string(), { maxLength: 3 }), fc.dictionary(fc.string({ maxLength: 5 }), fc.string({ maxLength: 5 }), { maxKeys: 3 }));

/** The string leaves of a request, at least `min` units long and not among `known` (field names and allowlisted names, which a statement rightly holds), for the check that none is statement text. */
export function textLeaves(value: unknown, known: ReadonlySet<string>, min = 4): string[] {
  if (typeof value === 'string') return value.length >= min && !known.has(value) && ![...known].some((name) => name.toLowerCase() === value.toLowerCase()) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry: unknown) => textLeaves(entry, known, min));
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, entry]) => [...textLeaves(key, known, min), ...textLeaves(entry, known, min)]);
  return [];
}

/** The names of the request fields of the read routes. */
export const FIELD_NAMES: readonly string[] = ['sourceId', 'entityType', 'stableId', 'neighborTypes', 'relTypes', 'direction', 'limit', 'cursors', 'mask', 'ref', 'value', 'text', 'entityTypes', 'matchModes', 'typeahead', 'group', 'cursor', 'exactRefs', 'entities', 'loadedRelationships', 'loadedQuality', 'filters', 'rank', 'order', 'property', 'values', 'from', 'kind', 'neighbor', 'relationship', 'between', 'number', 'boolean', 'date', 'dateTime', 'localDateTime', 'time', 'localTime'];
