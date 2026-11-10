import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * The wording check. A person reads "relationship", never "edge" (the graph word). This scans the text a person can read in a source tree: string and template literals, JSX text and the visible props of an
 * element. Code is not text: a selector, a key, an import, an error message and a test are skipped. "Link" is not scanned, because the source link is a feature of its own and a scan cannot tell it from a
 * relationship.
 */
const VISIBLE_PROPS = new Set(['aria-label', 'aria-description', 'title', 'placeholder', 'alt', 'label']);
const BANNED = /\bedges?\b/i;
/** Text that is code and never read: a Cytoscape selector (`edge[...]`, `node, edge`), a request path, or the start of a serialized key. */
const CODE = /^(edge(\[|\.|:)|(node|edge)(, (node|edge))*$|\/|\[")/;

/** Folders and files that hold no text a person reads: development pages, test tools and test data, the statements sent to the source. */
const SKIPPED_FOLDERS = new Set(['dev', 'node_modules', 'testing', 'templates', 'fuzz']);

export function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return SKIPPED_FOLDERS.has(entry.name) ? [] : sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.(test|neo4j\.test)\.tsx?$/.test(entry.name) && !/-kit\.tsx?$/.test(entry.name) && entry.name !== 'test-data.ts' && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const COMPARISONS = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken]);

/** Nodes a text passes through on its way to the place that uses it: the text of `cond ? 'a' : 'b'`, of `` `${x} a` `` or of `'a' + b` is used where the whole is used. */
const passesThrough = (node: ts.Node): boolean =>
  ts.isParenthesizedExpression(node) || ts.isTemplateExpression(node) || ts.isTemplateSpan(node) || ts.isConditionalExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node) || (ts.isBinaryExpression(node) && !COMPARISONS.has(node.operatorToken.kind));

/**
 * Whether the text is code and not words: judged by the one place that uses it (an import, a type, a comparison, a `case`, the key of an element access, the message of an error, a call to the test
 * tools). A text that is the receiver of a chained call, the member of an array, or returned from a function is words; a `switch` or a `.map` around it does not make it code.
 */
/** Whether the text is one piece of a sentence that is put together: a part of a template (`${n} ${n === 1 ? 'edge' : 'edges'} left`) or of a `+`. Such a piece is judged as part of the whole, so a single word in it still counts. */
const composed = (node: ts.Node): boolean => {
  for (let parent: ts.Node | undefined = node.parent; parent !== undefined && passesThrough(parent); parent = parent.parent) {
    if (ts.isTemplateExpression(parent) || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.PlusToken)) return true;
  }
  return false;
};

const insideCode = (node: ts.Node): boolean => {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent;
  while (parent !== undefined && passesThrough(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (parent === undefined) return false;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent) || ts.isLiteralTypeNode(parent)) return true;
  if (ts.isNewExpression(parent)) return /Error$/.test(parent.expression.getText());
  if (ts.isBinaryExpression(parent)) return COMPARISONS.has(parent.operatorToken.kind);
  if (ts.isCaseClause(parent)) return parent.expression === child;
  if (ts.isElementAccessExpression(parent)) return parent.argumentExpression === child;
  if (ts.isCallExpression(parent)) return /^(console\.|expect|describe|it$)/.test(parent.expression.getText());
  return false;
};

/** The text a person can read in one source file, with where it is. */
export function readableText(path: string, root: string, text = readFileSync(path, 'utf8'), prose = false): { readonly text: string; readonly where: string }[] {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: { text: string; where: string }[] = [];
  const add = (node: ts.Node, value: string): void => {
    const piece = composed(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node);
    const trimmed = value.trim();
    const wordInASentence = ts.isStringLiteral(node) && composed(node);
    if (trimmed === '' || (!wordInASentence && CODE.test(value))) return;
    // on the server a text is words when it has a space; a single token is a code, a name or a path
    if (prose && !piece && !/\s/.test(trimmed)) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart());
    found.push({ text: trimmed, where: `${relative(root, path)}:${line + 1}` });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isJsxText(node)) add(node, node.text);
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && !insideCode(node)) {
      const inJsxProp = ts.isJsxAttribute(node.parent) ? VISIBLE_PROPS.has(node.parent.name.getText()) : undefined;
      if (inJsxProp !== false && !((node.text === 'edge' || node.text === 'edges') && !composed(node))) add(node, node.text);
    } else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      if (!insideCode(node)) add(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** What the scan finds that says "edge" or "edges". */
export const bannedWords = (path: string, root: string, text?: string, prose = false): string[] => readableText(path, root, text, prose).filter((entry) => BANNED.test(entry.text)).map((entry) => `${entry.where}: ${entry.text}`);

