import { isAlias, isMap, isPair, isScalar, isSeq, LineCounter, Parser, type Document } from 'yaml';
import type { MappingIssue } from './diagnostics.js';

const ALLOWED_SCALAR_STYLES: ReadonlySet<string | undefined> = new Set(['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE']);
const SUPPORTED_VERSION = '1.2';
const MERGE_KEY = '<<';

type Range = readonly number[] | null | undefined;

function positionOf(lines: LineCounter, range: Range): Pick<MappingIssue, 'line' | 'column'> {
  const start = range?.[0];
  if (start === undefined) return {};
  const { line, col } = lines.linePos(start);
  return { line, column: col };
}

function streamProblems(text: string): MappingIssue[] {
  const counter = new LineCounter();
  const problems: MappingIssue[] = [];
  let documents = 0;
  for (const token of new Parser(counter.addNewLine).parse(text)) {
    if (token.type === 'document') {
      documents += 1;
      const [first] = token.start;
      if (documents === 2) problems.push({ path: '', reason: 'has more than one document', ...positionOf(counter, [first?.offset ?? 0]) });
      continue;
    }
    if (token.type !== 'directive') continue;
    const [name = '', version] = token.source.trim().split(/\s+/);
    const where = positionOf(counter, [token.offset]);
    if (name === '%YAML' && version !== SUPPORTED_VERSION) problems.push({ path: '', reason: 'declares a YAML version other than 1.2', ...where });
    else if (name !== '%YAML') problems.push({ path: '', reason: `uses a ${name} directive, which a mapping does not allow`, ...where });
  }
  return problems;
}

function rangeOf(node: unknown): Range {
  return typeof node === 'object' && node !== null && 'range' in node && Array.isArray(node.range) ? node.range : null;
}

/** Walks every node and allows only maps, sequences and plain or quoted scalars; any other node type, known or not, is refused. */
export function nodeProblems(root: unknown, lines: LineCounter): MappingIssue[] {
  const problems: MappingIssue[] = [];
  const report = (reason: string, range: Range): void => {
    problems.push({ path: '', reason, ...positionOf(lines, range) });
  };
  const reportCommon = (node: { readonly anchor?: string; readonly tag?: string; readonly range?: Range }): void => {
    if (node.anchor !== undefined) report('uses an anchor, which a mapping does not allow', node.range);
    if (node.tag !== undefined) report('uses a tag, which a mapping does not allow', node.range);
  };

  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node === null || node === undefined) continue;
    if (isAlias(node)) {
      report('uses an alias, which a mapping does not allow', node.range);
    } else if (isScalar(node)) {
      reportCommon(node);
      if (!ALLOWED_SCALAR_STYLES.has(node.type)) report('uses a block or unsupported text style', node.range);
    } else if (isSeq(node)) {
      reportCommon(node);
      pending.push(...[...node.items].reverse());
    } else if (isMap(node)) {
      reportCommon(node);
      for (const item of [...node.items].reverse()) {
        if (!isPair(item)) {
          report('uses a construct a mapping does not allow', node.range);
          continue;
        }
        pending.push(item.value);
        if (!isScalar(item.key)) report('has a key that is not plain text', isMap(item.key) || isSeq(item.key) ? item.key.range : node.range);
        else if (item.key.value === MERGE_KEY) report('uses a merge key, which a mapping does not allow', item.key.range);
        else pending.push(item.key);
      }
    } else {
      report('uses a construct a mapping does not allow', rangeOf(node));
    }
  }
  return problems.sort((left, right) => (left.line ?? 0) - (right.line ?? 0) || (left.column ?? 0) - (right.column ?? 0));
}

export function subsetProblems(document: Document, text: string, lines: LineCounter): MappingIssue[] {
  return [...streamProblems(text), ...nodeProblems(document.contents, lines)];
}
