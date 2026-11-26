// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = import.meta.dirname;
const DEVELOPMENT_PAGES = 'dev';

// the list of codes the tests look for: no product module imports it
const CODE_LIST = join('patterns', 'no-codes.ts');

const isProductSource = (path: string): boolean => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) && !path.startsWith(DEVELOPMENT_PAGES) && path !== CODE_LIST;

const isCode = (node: ts.Expression): boolean => (ts.isIdentifier(node) && node.text === 'code') || (ts.isPropertyAccessExpression(node) && node.name.text === 'code');

/** Whether what is written is only a name for the machine: a React key, or the message of an error a developer throws. */
function isNotShown(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node; at !== undefined; at = at.parent) {
    if (ts.isJsxAttribute(at) && at.name.getText() === 'key') return true;
    if (ts.isThrowStatement(at) || (ts.isNewExpression(at) && at.expression.getText().endsWith('Error')) || (ts.isCallExpression(at) && at.expression.kind === ts.SyntaxKind.SuperKeyword)) return true;
  }
  return false;
}

/** The lines of a source file that write a code into text: into a template, into JSX or onto a string. It follows the name: a code first copied into a variable of another name is not seen here, only by the tests that read the screens. */
function codesWritten(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const report = (node: ts.Expression): void => {
    if (isCode(node) && !isNotShown(node)) found.push(`${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isTemplateSpan(node)) report(node.expression);
    if (ts.isJsxExpression(node) && node.expression !== undefined && !ts.isJsxAttribute(node.parent)) report(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      if (ts.isStringLiteralLike(node.left)) report(node.right);
      if (ts.isStringLiteralLike(node.right)) report(node.left);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe('the text of the product', () => {
  it('writes no failure code into what a person reads', () => {
    const files = readdirSync(ROOT, { recursive: true, encoding: 'utf8' }).map((path) => relative(ROOT, join(ROOT, path))).filter(isProductSource);
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((path) => codesWritten(path, readFileSync(join(ROOT, path), 'utf8')))).toEqual([]);
  });

  it('would be caught writing one into a template, into JSX or onto a string, and not as a key or in a thrown error', () => {
    const planted = [
      'export const a = (failure: { code: string }) => `Not read (${failure.code}).`;',
      'export const B = ({ code }: { code: string }) => <p>Unavailable · {code}</p>;',
      "export const c = (failure: { code: string }) => 'Not read ' + failure.code;",
      'export const D = ({ code }: { code: string }) => <p key={`${code}-1`}>text</p>;',
      'export const e = (code: string) => { throw new Error(`no entry for ${code}`); };',
    ].join('\n');
    expect(codesWritten('planted.tsx', planted)).toEqual(['planted.tsx:1', 'planted.tsx:2', 'planted.tsx:3']);
  });
});
