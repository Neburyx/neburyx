/**
 * Start-up check of one intent's query text, before it is ever sent to a database. Pure: it returns problems, one sentence each, and never echoes any text of the query beyond a keyword, a clause name, a function name or a parameter name.
 *
 * Approach: the text is first split into tokens (strings, comments and backticked names are skipped as non-code). Then every unquoted word is judged by an allowlist: a word that starts a clause and is not one of the nine allowed starters is refused. Words that can only be clauses or commands are held in one fixed set. Any other unknown word that follows a finished expression is refused too, because it can only be the start of a clause. A word after a dot or a colon (property, label, type) and a map key is not a clause. The body of EXISTS, COUNT and COLLECT subqueries is checked by the same rules.
 */

const ALLOWED_STARTERS: ReadonlySet<string> = new Set(['MATCH', 'OPTIONAL', 'WHERE', 'WITH', 'RETURN', 'ORDER', 'SKIP', 'LIMIT', 'UNWIND']);

const REFUSED_WORDS: ReadonlySet<string> = new Set([
  'CREATE', 'MERGE', 'DELETE', 'DETACH', 'SET', 'REMOVE', 'FOREACH', 'LOAD', 'USE', 'CALL', 'UNION', 'PROFILE', 'EXPLAIN', 'INSERT', 'FINISH', 'LET',
  'FILTER', 'NEXT', 'OFFSET', 'CYPHER', 'SHOW', 'TERMINATE', 'ALTER', 'DROP', 'GRANT', 'DENY', 'REVOKE', 'START', 'STOP', 'ENABLE', 'YIELD', 'RENAME',
  'ALLOCATE', 'DEALLOCATE', 'CSV',
]);

const EXPRESSION_WORDS: ReadonlySet<string> = new Set([
  'AS', 'AND', 'OR', 'XOR', 'NOT', 'IN', 'IS', 'NULL', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DISTINCT', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING',
  'STARTS', 'ENDS', 'CONTAINS', 'ALL', 'ANY', 'NONE', 'SINGLE', 'SHORTEST', 'TRUE', 'FALSE', 'COUNT', 'EXISTS', 'COLLECT', 'BY',
  'WALK', 'TRAIL', 'ACYCLIC', 'REPEATABLE', 'ELEMENTS', 'PATHS', 'PATH', 'GROUPS', 'GROUP',
]);

/** Keywords that end an expression, so a word right after one is still a word after a finished expression. */
const VALUE_WORDS: ReadonlySet<string> = new Set(['NULL', 'TRUE', 'FALSE', 'END', 'ASC', 'DESC', 'ASCENDING', 'DESCENDING']);

const SUBQUERY_WORDS: ReadonlySet<string> = new Set(['EXISTS', 'COUNT', 'COLLECT']);
const BUILT_IN_NAMESPACES: ReadonlySet<string> = new Set(['date', 'datetime', 'localdatetime', 'time', 'localtime', 'duration', 'point', 'vector']);
const CLOSERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };
const PARAMETER_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLAIN_NAME = /^[A-Za-z0-9_.]{1,80}$/;
const MAX_SUBQUERY_DEPTH = 16;

type Token =
  | { readonly kind: 'word'; readonly text: string; readonly upper: string; readonly quoted: boolean }
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'value' }
  | { readonly kind: 'sym'; readonly text: string };

const isWordStart = (c: string): boolean => /^[A-Za-z_]$/.test(c);
const isWordPart = (c: string): boolean => /^[A-Za-z0-9_]$/.test(c);
const isAsciiWordPart = isWordPart;
const isPrintableAscii = (c: string): boolean => c.length === 1 && c >= '!' && c <= '~';
/** Line breaks that a database may read in a comment and this reader does not. */
const ODD_LINE_BREAKS = /[\u000B\u000C\u0085\u2028\u2029]/;

/** Index after the number that starts at `from`: digits and `_`, an optional fraction and exponent, or a `0x` or `0o` form. */
const skipNumber = (query: string, from: number): number => {
  const run = (start: number, pattern: RegExp): number => {
    let j = start;
    while (j < query.length && pattern.test(query.charAt(j))) j += 1;
    return j;
  };
  const marker = query.charAt(from + 1);
  if (query.charAt(from) === '0' && (marker === 'x' || marker === 'X')) return run(from + 2, /^[0-9A-Fa-f_]$/);
  if (query.charAt(from) === '0' && (marker === 'o' || marker === 'O')) return run(from + 2, /^[0-7_]$/);
  let j = run(from, /^[0-9_]$/);
  if (query.charAt(j) === '.' && isDigit(query.charAt(j + 1))) j = run(j + 1, /^[0-9_]$/);
  const e = query.charAt(j);
  if (e === 'e' || e === 'E') {
    const sign = query.charAt(j + 1);
    const digit = sign === '+' || sign === '-' ? j + 2 : j + 1;
    if (isDigit(query.charAt(digit))) j = run(digit, /^[0-9_]$/);
  }
  return j;
};
const isDigit = (c: string): boolean => c >= '0' && c <= '9' && c.length === 1;

interface Tokens {
  readonly tokens: readonly Token[];
  readonly unreadable: boolean;
  readonly notes: readonly string[];
}

/** Reads a backticked name starting at the opening backtick; a doubled backtick is one backtick of the name. */
const readBackticked = (query: string, from: number): { readonly text: string; readonly next: number } | undefined => {
  let i = from + 1;
  let text = '';
  while (i < query.length) {
    const c = query.charAt(i);
    if (c === '`') {
      if (query.charAt(i + 1) === '`') {
        text += '`';
        i += 2;
        continue;
      }
      return { text, next: i + 1 };
    }
    text += c;
    i += 1;
  }
  return undefined;
};

const tokenize = (query: string): Tokens => {
  const tokens: Token[] = [];
  const notes = new Set<string>();
  let i = 0;
  while (i < query.length) {
    const c = query.charAt(i);
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v') {
      i += 1;
    } else if (c === '/' && query.charAt(i + 1) === '/') {
      const from = i;
      while (i < query.length && query.charAt(i) !== '\n' && query.charAt(i) !== '\r') i += 1;
      if (ODD_LINE_BREAKS.test(query.slice(from, i))) notes.add('a comment holds a line break character other than a plain one');
    } else if (c === '/' && query.charAt(i + 1) === '*') {
      const end = query.indexOf('*/', i + 2);
      if (end < 0) return { tokens, unreadable: true, notes: [...notes] };
      i = end + 2;
    } else if (c === "'" || c === '"') {
      let closed = false;
      i += 1;
      while (i < query.length) {
        const d = query.charAt(i);
        if (d === '\\') {
          i += 2;
        } else if (d === c) {
          i += 1;
          closed = true;
          break;
        } else {
          i += 1;
        }
      }
      if (!closed) return { tokens, unreadable: true, notes: [...notes] };
      tokens.push({ kind: 'value' });
    } else if (c === '`') {
      const name = readBackticked(query, i);
      if (name === undefined) return { tokens, unreadable: true, notes: [...notes] };
      tokens.push({ kind: 'word', text: name.text, upper: name.text.toUpperCase(), quoted: true });
      i = name.next;
    } else if (c === '$') {
      if (query.charAt(i + 1) === '`') {
        const name = readBackticked(query, i + 1);
        if (name === undefined) return { tokens, unreadable: true, notes: [...notes] };
        tokens.push({ kind: 'param', name: name.text });
        i = name.next;
      } else {
        let j = i + 1;
        while (j < query.length && isAsciiWordPart(query.charAt(j))) j += 1;
        tokens.push({ kind: 'param', name: query.slice(i + 1, j) });
        i = j;
      }
    } else if (isDigit(c)) {
      const j = skipNumber(query, i);
      if (isWordPart(query.charAt(j)) || (query.charAt(j) === '.' && isWordStart(query.charAt(j + 1)))) notes.add('a number runs into a word');
      tokens.push({ kind: 'value' });
      i = j;
    } else if (isWordStart(c)) {
      let j = i + 1;
      while (j < query.length && isWordPart(query.charAt(j))) j += 1;
      const text = query.slice(i, j);
      tokens.push({ kind: 'word', text, upper: text.toUpperCase(), quoted: false });
      i = j;
    } else {
      if (isPrintableAscii(c)) tokens.push({ kind: 'sym', text: c });
      else notes.add('the query holds a character outside plain ASCII or whitespace');
      i += 1;
    }
  }
  return { tokens, unreadable: false, notes: [...notes] };
};

const symOf = (token: Token | undefined): string => (token?.kind === 'sym' ? token.text : '');
const wordOf = (token: Token | undefined): string => (token?.kind === 'word' && !token.quoted ? token.upper : '');

/** Index of the closer of each opener, or -1; `balanced` is false when a bracket is left open, closes nothing or closes the wrong kind. */
const matchBrackets = (tokens: readonly Token[]): { readonly closeOf: readonly number[]; readonly balanced: boolean } => {
  const closeOf: number[] = tokens.map(() => -1);
  const open: number[] = [];
  let balanced = true;
  tokens.forEach((token, index) => {
    const text = symOf(token);
    if (text in CLOSERS) {
      open.push(index);
    } else if (text === ')' || text === ']' || text === '}') {
      const top = open.pop();
      if (top === undefined || CLOSERS[symOf(tokens[top])] !== text) balanced = false;
      else closeOf[top] = index;
    }
  });
  return { closeOf, balanced: balanced && open.length === 0 };
};

const endsExpression = (token: Token | undefined): boolean => {
  if (token === undefined) return false;
  if (token.kind === 'value' || token.kind === 'param') return true;
  if (token.kind === 'word') {
    if (token.quoted) return true;
    if (VALUE_WORDS.has(token.upper)) return true;
    return !EXPRESSION_WORDS.has(token.upper) && !ALLOWED_STARTERS.has(token.upper) && !REFUSED_WORDS.has(token.upper);
  }
  return token.text === ')' || token.text === ']' || token.text === '}';
};

interface Scan {
  readonly say: (sentence: string) => void;
  readonly tokens: readonly Token[];
  readonly closeOf: readonly number[];
}

const checkClauses = (scan: Scan, start: number, end: number, body: boolean, level: number): void => {
  const { say, tokens, closeOf } = scan;
  if (end <= start) {
    say(body ? 'a subquery is empty' : 'the query is empty');
    return;
  }
  const first = tokens[start];
  const firstWord = wordOf(first);
  const startsWithPattern = body && symOf(first) === '(';
  if (!startsWithPattern && !ALLOWED_STARTERS.has(firstWord) && !REFUSED_WORDS.has(firstWord)) {
    say(body ? 'a subquery does not start with a clause or a pattern' : 'the query does not start with a clause');
  }
  const brackets: string[] = [];
  let i = start;
  while (i < end) {
    const token = tokens[i];
    const prev = i > start ? tokens[i - 1] : undefined;
    const text = symOf(token);
    if (text === '{' && SUBQUERY_WORDS.has(wordOf(tokens[i - 1])) && !['.', ':'].includes(symOf(tokens[i - 2]))) {
      if (level >= MAX_SUBQUERY_DEPTH) say('subqueries are nested too deeply');
      else checkClauses(scan, i + 1, closeOf[i] ?? end, true, level + 1);
      i = (closeOf[i] ?? end) + 1;
      continue;
    }
    if (text in CLOSERS) brackets.push(text);
    else if (text === ')' || text === ']' || text === '}') brackets.pop();
    if (token?.kind === 'word' && !token.quoted) {
      const afterNameMark = ['.', ':'].includes(symOf(prev));
      const mapKey = brackets[brackets.length - 1] === '{' && symOf(tokens[i + 1]) === ':';
      const word = token.upper;
      if (!afterNameMark && !mapKey) {
        if (REFUSED_WORDS.has(word)) {
          say(`the clause ${word} is not allowed (a reserved word; put it in backticks to use it as a name)`);
        } else if (word === 'OPTIONAL' && wordOf(tokens[i + 1]) !== 'MATCH') {
          say('the clause OPTIONAL must be followed by MATCH');
        } else if (word === 'ORDER' && wordOf(tokens[i + 1]) !== 'BY') {
          say('the clause ORDER must be followed by BY');
        } else if (brackets.length === 0 && !ALLOWED_STARTERS.has(word) && !EXPRESSION_WORDS.has(word) && endsExpression(prev)) {
          say('a word that is not a known clause or operator follows an expression');
        }
      }
    }
    i += 1;
  }
};

const functionName = (tokens: readonly Token[], open: number): string | undefined => {
  const last = tokens[open - 1];
  if (last?.kind !== 'word') return undefined;
  const parts = [last.text];
  let j = open - 2;
  while (symOf(tokens[j]) === '.') {
    const part = tokens[j - 1];
    if (part?.kind !== 'word') break;
    parts.unshift(part.text);
    j -= 2;
  }
  return parts.join('.');
};

export function checkIntentQuery(input: { readonly intent: string; readonly query: string; readonly parameters: readonly string[] }): readonly string[] {
  const found = new Set<string>();
  const say = (sentence: string): void => {
    found.add(`intent "${input.intent}": ${sentence}`);
  };
  const { tokens, unreadable, notes } = tokenize(input.query);
  for (const note of notes) say(note);
  if (unreadable) {
    say('the query does not read as a token stream (a string, comment or quoted name is not closed)');
    return [...found];
  }

  const used = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'param') continue;
    if (PARAMETER_NAME.test(token.name)) used.add(token.name);
    else if (/^[A-Za-z0-9_]+$/.test(token.name)) say(`the parameter $${token.name} does not have a valid name`);
    else say('a parameter has a name that is not a plain identifier');
  }
  const declared = new Set(input.parameters);
  for (const name of declared) if (!used.has(name)) say(`the parameter $${name} is declared but not used in the query`);
  for (const name of used) if (!declared.has(name)) say(`the query uses the parameter $${name} that is not declared`);

  if (tokens.some((token) => symOf(token) === ';')) say('the character ; is not allowed, it would start a second statement');

  tokens.forEach((token, index) => {
    if (symOf(token) !== '(') return;
    const name = functionName(tokens, index);
    if (name === undefined) return;
    if (!name.includes('.')) return;
    const namespace = (name.split('.')[0] ?? '').toLowerCase();
    if (!BUILT_IN_NAMESPACES.has(namespace)) say(`the function ${PLAIN_NAME.test(name) ? name : 'with a namespace'} is not allowed`);
  });

  const { closeOf, balanced } = matchBrackets(tokens);
  if (!balanced) {
    say('the brackets of the query do not balance');
    return [...found];
  }
  checkClauses({ say, tokens, closeOf }, 0, tokens.length, false, 0);
  return [...found];
}
