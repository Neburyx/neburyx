/**
 * Shapes of graph-query text. A request to the model and an answer of the plan route hold none of them: a plan is a template and parameters, never a query. Test support only.
 * The words of a query language are matched in capitals, as a query writes them, so the ordinary words of the catalog (match, return, set) are not mistaken for one.
 */
export const QUERY_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp; readonly sample: string }[] = [
  { name: 'a clause with a node pattern', pattern: /\b(?:MATCH|MERGE|CREATE|OPTIONAL MATCH)\s*\(\s*\w*\s*(?::\s*\w+)?\s*\)/i, sample: 'MATCH (n:Person) RETURN n' },
  { name: 'a relationship pattern', pattern: /\)\s*-\s*\[[^\]]*\]\s*->?\s*\(/, sample: '(a)-[r:KNOWS]->(b)' },
  { name: 'a statement terminator before a clause', pattern: /;\s*(?:MATCH|CREATE|DELETE|DROP|RETURN|CALL|MERGE|SET)\b/, sample: 'RETURN 1; DROP DATABASE x' },
  { name: 'a procedure call', pattern: /\bCALL\s+[a-z_]+(?:\.[a-z_]+)+\s*\(|\b(?:apoc|dbms|db)\.[a-z]+(?:\.[a-z]+)*\s*\(/i, sample: 'CALL db.labels()' },
  { name: 'the words of a query language as a clause', pattern: /\b(?:MATCH|RETURN|DETACH DELETE|DELETE|MERGE|UNWIND|CREATE|DROP)\s+[\w(*`]/, sample: 'please DELETE n' },
];

/** The names of the patterns that match a text; none for a text that holds no query. */
export function queryTextIn(text: string): readonly string[] {
  return QUERY_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}
