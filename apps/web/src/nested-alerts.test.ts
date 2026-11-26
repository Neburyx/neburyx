// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/** The components that draw an alert of their own. */
const HOLDS_AN_ALERT: ReadonlySet<string> = new Set(['FailureNotice', 'ListFailure', 'FailureBox', 'SearchFailed', 'RereadFailure']);

const opening = (node: ts.Node): ts.JsxOpeningLikeElement | undefined => (ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined);
const isAlert = (element: ts.JsxOpeningLikeElement): boolean => element.attributes.properties.some((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText() === 'role' && attribute.initializer?.getText() === '"alert"');

/** The lines of a source file where an alert stands inside another, which a screen reader may say twice or not at all. */
function nestedAlerts(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node, inside: boolean): void => {
    const element = opening(node);
    if (element !== undefined && inside && (isAlert(element) || HOLDS_AN_ALERT.has(element.tagName.getText()))) found.push(`${name}:${file.getLineAndCharacterOfPosition(element.getStart()).line + 1}`);
    const within = inside || (element !== undefined && isAlert(element));
    ts.forEachChild(node, (child) => visit(child, ts.isJsxOpeningElement(child) ? inside : within));
  };
  visit(file, false);
  return found;
}

describe('the alerts of the product', () => {
  it('never stand one inside another', () => {
    const root = import.meta.dirname;
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter((path) => /\.tsx$/.test(path) && !/\.test\.tsx$/.test(path) && !path.startsWith('dev'));
    expect(files.length).toBeGreaterThan(50);
    expect(files.flatMap((path) => nestedAlerts(path, readFileSync(join(root, path), 'utf8')))).toEqual([]);
  });

  it('would be caught holding a notice or another alert, and not when they stand side by side', () => {
    const planted = [
      'export const A = () => <div role="alert"><FailureNotice failure={f} /></div>;',
      'export const B = () => <div role="alert"><p role="alert">no</p></div>;',
      'export const C = () => <div><p role="alert">one</p><FailureNotice failure={f} /></div>;',
      'export const D = () => <p role="alert">one</p>;',
    ].join('\n');
    expect(nestedAlerts('planted.tsx', planted)).toEqual(['planted.tsx:1', 'planted.tsx:2']);
  });
});
