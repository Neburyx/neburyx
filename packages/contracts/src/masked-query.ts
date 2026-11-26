/**
 * Whether the text of a file query may use one of the given properties, for a request that asks for masking: a masked property must not be searched, filtered or sorted by. It fails closed: it answers true for a use it
 * can see and for every form whose property it cannot name. It reads the tokens of `checkIntentQuery`, so strings and comments are not code; call it only for a query that check passed.
 */
import { ALLOWED_STARTERS, EXPRESSION_WORDS, matchBrackets, SUBQUERY_WORDS, symOf, tokenize, VALUE_WORDS, type Token } from './query-check.js';

/** The functions a masked query may call: each takes values, lists or whole elements by identity, never the name of a property or a map that stands for one. Compared in lower case; any other call is refused. */
const FUNCTIONS: ReadonlySet<string> = new Set(
  [
    'count collect sum avg min max stdev stdevp percentilecont percentiledisc',
    'all any none single exists',
    'coalesce elementid id type length size startnode endnode head last toboolean tobooleanornull tofloat tofloatornull tointeger tointegerornull tostring tostringornull char_length character_length timestamp randomuuid',
    'labels nodes relationships range reverse tail reduce tobooleanlist tofloatlist tointegerlist tostringlist',
    'abs ceil floor isnan rand round sign e exp log log10 sqrt pi sin cos tan cot asin acos atan atan2 degrees radians haversin',
    'left right substring split replace trim ltrim rtrim btrim lower upper tolower toupper normalize',
    'shortestpath allshortestpaths',
    'duration.between duration.indays duration.inmonths duration.inseconds point.distance point.withinbbox vector.similarity.cosine vector.similarity.euclidean',
  ].flatMap((group) => group.split(' ')),
);

/** Functions that also take a whole map, and so read keys the text never names; allowed only with nothing, one literal, one parameter or one map written out. */
const CONSTRUCTORS: ReadonlySet<string> = new Set(['date', 'datetime', 'localdatetime', 'time', 'localtime', 'duration', 'point']);

const KEYWORDS: ReadonlySet<string> = new Set([...ALLOWED_STARTERS, ...EXPRESSION_WORDS]);
/** The literals: no variable can be named as one of these. */
const LITERAL_WORDS: ReadonlySet<string> = new Set(['NULL', 'TRUE', 'FALSE']);
const ESCAPE = /\\u/i;

const normal = (name: string): string => name.normalize('NFC');

interface Read {
  readonly tokens: readonly Token[];
  readonly closeOf: readonly number[];
  readonly names: ReadonlySet<string>;
  /** The keywords the query uses as variable names, in upper case: before a `[` such a word is a value, not a keyword. */
  readonly variables: ReadonlySet<string>;
}

const plainWord = (token: Token | undefined): string => (token?.kind === 'word' && !token.quoted ? token.upper : '');
const afterNameMark = (tokens: readonly Token[], index: number): boolean => ['.', ':'].includes(symOf(tokens[index - 1]));

/** A word that is written where a variable is bound: after `AS`, after `(` or `[` of a pattern, before `=`, or as the variable of a list predicate or comprehension. */
const bindsVariable = (tokens: readonly Token[], index: number): boolean => {
  const before = symOf(tokens[index - 1]);
  const after = symOf(tokens[index + 1]);
  if (plainWord(tokens[index - 1]) === 'AS' || after === '=') return true;
  const inPattern = [':', ')', ']', '{', '*'].includes(after) || ['WHERE', 'IS'].includes(plainWord(tokens[index + 1])) || tokens[index + 1]?.kind === 'param';
  if ((before === '(' || before === '[') && inPattern) return true;
  return ['(', '[', ','].includes(before) && plainWord(tokens[index + 1]) === 'IN';
};

const keywordVariables = (tokens: readonly Token[]): ReadonlySet<string> =>
  new Set(tokens.flatMap((token, index) => (token.kind === 'word' && KEYWORDS.has(token.upper) && !LITERAL_WORDS.has(token.upper) && bindsVariable(tokens, index) ? [token.upper] : [])));

/** True for a `[` that follows a value, which reads an element, and so possibly a property, by a key the text does not name. */
const isSubscript = ({ tokens, variables }: Read, open: number): boolean => {
  const before = tokens[open - 1];
  if (before === undefined) return false;
  if (before.kind === 'sym') return [')', ']', '}'].includes(before.text);
  if (before.kind !== 'word' || before.quoted || afterNameMark(tokens, open - 1)) return true;
  return !KEYWORDS.has(before.upper) || VALUE_WORDS.has(before.upper) || variables.has(before.upper);
};

/** True for a `{` that opens the body of `EXISTS`, `COUNT` or `COLLECT`; a body never starts with a key and a colon, which a property map does. */
const opensSubquery = (tokens: readonly Token[], open: number): boolean =>
  SUBQUERY_WORDS.has(plainWord(tokens[open - 1])) && !afterNameMark(tokens, open - 1) && !(tokens[open + 1]?.kind === 'word' && symOf(tokens[open + 2]) === ':');

/** The constructor's argument list is nothing, one literal, one parameter or one map written out. */
const plainArguments = ({ tokens, closeOf }: Read, open: number): boolean => {
  const close = closeOf[open] ?? -1;
  const first = tokens[open + 1];
  if (close === open + 1) return true;
  if (close === open + 2) return first?.kind === 'value' || first?.kind === 'param';
  return symOf(first) === '{' && closeOf[open + 1] === close - 1;
};

/** True for a `(` that calls a function a masked query may not call. */
const isRefusedCall = (read: Read, open: number): boolean => {
  const { tokens } = read;
  const last = tokens[open - 1];
  if (last?.kind !== 'word') return false;
  const parts = [last];
  for (let at = open - 2; symOf(tokens[at]) === '.'; at -= 2) {
    const part = tokens[at - 1];
    if (part?.kind !== 'word') break;
    parts.unshift(part);
  }
  if (parts.length === 1 && !last.quoted && !afterNameMark(tokens, open - 1) && KEYWORDS.has(last.upper) && !FUNCTIONS.has(last.text.toLowerCase())) return false;
  if (parts.some((part) => part.quoted)) return true;
  const name = parts.map((part) => part.text.toLowerCase()).join('.');
  if (CONSTRUCTORS.has(name)) return !plainArguments(read, open);
  return !FUNCTIONS.has(name);
};

export function mayUseMaskedProperty(query: string, properties: readonly string[]): boolean {
  if (properties.length === 0) return false;
  // a database reads an escape as the character it stands for, anywhere in the text, so the tokens of a text that holds one are not what runs
  if (ESCAPE.test(query)) return true;
  const { tokens, unreadable, notes } = tokenize(query);
  const { closeOf, balanced } = matchBrackets(tokens);
  if (unreadable || notes.length > 0 || !balanced) return true;
  const read: Read = { tokens, closeOf, names: new Set(properties.map(normal)), variables: keywordVariables(tokens) };

  /** The open brackets, the innermost last: whether each is a map written in braces. */
  const maps: boolean[] = [];
  return tokens.some((token, index) => {
    if (token.kind === 'sym') {
      if (token.text === '{') maps.push(!opensSubquery(tokens, index));
      else if (token.text === '(' || token.text === '[') maps.push(false);
      else if ([')', ']', '}'].includes(token.text)) maps.pop();
      if (token.text === '[') return isSubscript(read, index);
      if (token.text === '(') return isRefusedCall(read, index);
      return token.text === '.' && symOf(tokens[index + 1]) === '*';
    }
    if (token.kind !== 'word') return false;
    const property = symOf(tokens[index - 1]) === '.';
    const key = maps.at(-1) === true && ['{', ','].includes(symOf(tokens[index - 1])) && symOf(tokens[index + 1]) === ':';
    if (plainWord(token) === 'CALL' && !afterNameMark(tokens, index) && !key) return true;
    return (property || key) && read.names.has(normal(token.text));
  });
}
