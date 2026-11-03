import { extname } from 'node:path';
import ts from 'typescript';

export type ImportForm = 'static' | 'type' | 'side-effect' | 'export-from' | 'export-star' | 'reexport-binding' | 'dynamic' | 'require';

export interface ImportRef {
  readonly specifier: string;
  readonly line: number;
  readonly form: ImportForm;
  readonly reexport: boolean;
}

type Origin = string | undefined;
type Declared = Map<ts.Node, Map<string, Origin>>;

export function scriptKindOf(fileName: string): ts.ScriptKind {
  switch (extname(fileName)) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function literalText(node: ts.Node | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAwaitExpression(current) || ts.isNonNullExpression(current) || ts.isAsExpression(current)) {
    current = current.expression;
  }
  return current;
}

/** The module a call such as require('x') or import('x') loads, if the specifier is a literal. */
function loadedModule(expression: ts.Expression): string | undefined {
  const call = unwrap(expression);
  if (!ts.isCallExpression(call)) return undefined;
  const isLoader = call.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(call.expression) && call.expression.text === 'require');
  return isLoader ? literalText(call.arguments[0]) : undefined;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name)) return name.elements.flatMap((element) => bindingNames(element.name));
  return name.elements.flatMap((element) => (ts.isBindingElement(element) ? bindingNames(element.name) : []));
}

function isBlockScope(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isSourceFile(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isCatchClause(node)
  );
}

function isFunctionScope(node: ts.Node): boolean {
  return ts.isFunctionLike(node) || ts.isClassStaticBlockDeclaration(node) || ts.isSourceFile(node) || ts.isModuleBlock(node);
}

function enclosing(node: ts.Node, wanted: (candidate: ts.Node) => boolean): ts.Node {
  let current = node.parent;
  while (!wanted(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

/** Every name declared in the file, in the scope that declares it, with the module it came from when the import form shows one. */
function declaredNames(source: ts.SourceFile): Declared {
  const declared: Declared = new Map();
  const declare = (scope: ts.Node, name: string, origin: Origin): void => {
    const names = declared.get(scope) ?? new Map<string, Origin>();
    names.set(name, origin);
    declared.set(scope, names);
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      const clause = node.importClause;
      if (clause) {
        if (clause.name) declare(source, clause.name.text, specifier);
        const named = clause.namedBindings;
        if (named && ts.isNamespaceImport(named)) declare(source, named.name.text, specifier);
        if (named && ts.isNamedImports(named)) for (const element of named.elements) declare(source, element.name.text, specifier);
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      const specifier = ts.isExternalModuleReference(node.moduleReference) ? literalText(node.moduleReference.expression) : undefined;
      declare(enclosing(node, isBlockScope), node.name.text, specifier);
    } else if (ts.isVariableDeclaration(node)) {
      const origin = node.initializer ? loadedModule(node.initializer) : undefined;
      const blockScoped = ts.isCatchClause(node.parent) || (ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.BlockScoped) !== 0);
      const scope = blockScoped ? (ts.isCatchClause(node.parent) ? node.parent : enclosing(node, isBlockScope)) : enclosing(node, isFunctionScope);
      for (const name of bindingNames(node.name)) declare(scope, name, origin);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) {
      declare(enclosing(node, isBlockScope), node.name.text, undefined);
    } else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
      declare(enclosing(node, isBlockScope), node.name.text, undefined);
    } else if ((ts.isFunctionExpression(node) || ts.isClassExpression(node)) && node.name) {
      declare(node, node.name.text, undefined);
    } else if (ts.isParameter(node) && ts.isFunctionLike(node.parent)) {
      for (const name of bindingNames(node.name)) declare(node.parent, name, undefined);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return declared;
}

function originOf(declared: Declared, at: ts.Node, name: string): Origin {
  for (let current: ts.Node | undefined = at; current; current = current.parent) {
    const names = declared.get(current);
    if (names?.has(name)) return names.get(name);
  }
  return undefined;
}

/** The identifier a plain forwarding expression starts from: a, a.b or a['b']; wrapping the value in a function is not forwarding. */
function forwardedRoot(expression: ts.Expression): ts.Identifier | undefined {
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) current = unwrap(current.expression);
  return ts.isIdentifier(current) ? current : undefined;
}

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function accessChain(expression: ts.Expression): string[] {
  const names: string[] = [];
  let current = unwrap(expression);
  while (ts.isPropertyAccessExpression(current)) {
    names.unshift(current.name.text);
    current = unwrap(current.expression);
  }
  if (ts.isIdentifier(current)) names.unshift(current.text);
  return names;
}

function isDeclared(declared: Declared, at: ts.Node, name: string): boolean {
  for (let current: ts.Node | undefined = at; current; current = current.parent) {
    if (declared.get(current)?.has(name)) return true;
  }
  return false;
}

/** Assignment to module.exports or exports.x, where `module` or `exports` is the CommonJS one and not a local of that name. */
function isCommonJsExport(declared: Declared, left: ts.Expression): boolean {
  const chain = accessChain(left);
  const root = chain[0];
  if (root === undefined || isDeclared(declared, left, root)) return false;
  return (root === 'module' && chain[1] === 'exports') || (root === 'exports' && chain.length > 1);
}

/** True when the loader call is exported as it is loaded: the initializer of an exported declaration, or an export assignment. */
function exportedAsLoaded(declared: Declared, call: ts.Expression): boolean {
  let child: ts.Node = call;
  let parent = call.parent;
  while (ts.isParenthesizedExpression(parent) || ts.isAwaitExpression(parent) || ts.isNonNullExpression(parent) || ts.isAsExpression(parent)) {
    child = parent;
    parent = parent.parent;
  }
  if (ts.isExportAssignment(parent)) return true;
  if (ts.isBinaryExpression(parent) && parent.right === child && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) return isCommonJsExport(declared, parent.left);
  if (ts.isVariableDeclaration(parent) && parent.initializer === child) {
    const list = parent.parent;
    return ts.isVariableDeclarationList(list) && ts.isVariableStatement(list.parent) && isExported(list.parent);
  }
  return false;
}

function isHiddenMember(node: ts.Node): boolean {
  if (!ts.isClassElement(node)) return false;
  const modifiers = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword) || (node.name !== undefined && ts.isPrivateIdentifier(node.name));
}

/**
 * The top-level statement whose shown surface holds this inline import type, or undefined when the type only sits in
 * implementation: a block, a static block, an initializer, an assertion, a private class member, or an unexported
 * member of a namespace.
 */
function surfaceStatement(typeNode: ts.Node): ts.Node | undefined {
  let child: ts.Node = typeNode;
  for (let current: ts.Node = typeNode.parent; !ts.isSourceFile(current); child = current, current = current.parent) {
    if (ts.isBlock(current) || ts.isClassStaticBlockDeclaration(current)) return undefined;
    if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isSatisfiesExpression(current)) return undefined;
    if ('initializer' in current && current.initializer === child) return undefined;
    if (isHiddenMember(current)) return undefined;
    if (ts.isModuleBlock(current.parent) && !isExported(current)) return undefined;
    if (ts.isSourceFile(current.parent)) return current;
  }
  return undefined;
}

function declaredTypeName(statement: ts.Node): string | undefined {
  return (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name
    ? statement.name.text
    : undefined;
}

// Only escapes that give a control character or punctuation other than a hyphen are harmless; any other letter, a digit (octal, \0 included) or a hyphen can spell a name or the character beside it.
const HARMLESS_ESCAPED = String.raw`[ntrbfv\\'"\x60$/.()[\]{}|*+?^:]`;
const NAME_SPELLING_ESCAPE = new RegExp(String.raw`^(?:[^\\]|\\${HARMLESS_ESCAPED})*\\(?!${HARMLESS_ESCAPED})`);

/** A specifier that reaches a target holds the target's name unless an escape spells it, so a file with neither need not be parsed. */
export function mayNameTarget(text: string, name: RegExp): boolean {
  return name.test(text) || NAME_SPELLING_ESCAPE.test(text);
}

export function readImports(fileName: string, text: string): ImportRef[] {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
  const declared = declaredNames(source);
  const carriers = new Map<string, string[]>();
  const refs: ImportRef[] = [];
  const add = (node: ts.Node, specifier: string, form: ImportForm, reexport = false): void => {
    refs.push({ specifier, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, form, reexport });
  };
  const addForwarded = (node: ts.Node, expression: ts.Expression): void => {
    const root = forwardedRoot(expression);
    const origin = root === undefined ? undefined : originOf(declared, root, root.text);
    if (origin !== undefined) add(node, origin, 'reexport-binding', true);
  };

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) add(node, specifier, !node.importClause ? 'side-effect' : node.importClause.isTypeOnly ? 'type' : 'static');
    } else if (ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier !== undefined) {
        add(node, specifier, node.exportClause ? 'export-from' : 'export-star', true);
      } else if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        for (const element of node.exportClause.elements) {
          const local = (element.propertyName ?? element.name).text;
          const origin = originOf(declared, element, local);
          if (origin !== undefined) add(element, origin, 'reexport-binding', true);
          for (const carried of carriers.get(local) ?? []) add(element, carried, 'reexport-binding', true);
        }
      }
    } else if (ts.isExportAssignment(node)) {
      addForwarded(node, node.expression);
    } else if (ts.isVariableStatement(node) && isExported(node)) {
      for (const declaration of node.declarationList.declarations) if (declaration.initializer) addForwarded(declaration, declaration.initializer);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isCommonJsExport(declared, node.left)) {
      addForwarded(node, node.right);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier !== undefined) add(node, specifier, 'require', isExported(node));
    } else if (ts.isImportTypeNode(node)) {
      const specifier = ts.isLiteralTypeNode(node.argument) ? literalText(node.argument.literal) : undefined;
      if (specifier !== undefined) {
        const statement = surfaceStatement(node);
        const name = statement && !isExported(statement) ? declaredTypeName(statement) : undefined;
        if (name !== undefined) carriers.set(name, [...(carriers.get(name) ?? []), specifier]);
        add(node, specifier, 'type', statement !== undefined && isExported(statement));
      }
    } else if (ts.isCallExpression(node)) {
      const specifier = literalText(node.arguments[0]);
      if (specifier !== undefined && node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, specifier, 'dynamic', exportedAsLoaded(declared, node));
      else if (specifier !== undefined && ts.isIdentifier(node.expression) && node.expression.text === 'require') add(node, specifier, 'require', exportedAsLoaded(declared, node));
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return refs;
}
