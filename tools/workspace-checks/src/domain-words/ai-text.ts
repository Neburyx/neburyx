import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { loadTree } from '../architecture/tree.js';
import { scriptKindOf } from '../architecture/imports.js';
import { readIdentifiers, type Identifier } from './packs.js';

/** The folders that hold the text the product sends a model as instructions: prompt files, and the string literals of the code that builds the agent, router and step texts. */
const AI_TEXT_PROMPT_FOLDERS: readonly string[] = ['ee/ask/prompts'];
const AI_TEXT_CODE_ROOTS: readonly string[] = ['ee/ask/src', 'ee/assistant-agent/src', 'ee/ai-runtime/src'];

/** A literal is read as instruction text when it is a sentence: long enough and with spaces. A name, a key or a path is not text a model reads. */
const SENTENCE_MIN_LENGTH = 40;

interface AiTextViolation {
  readonly file: string;
  readonly line: number;
  readonly word: string;
  readonly uses: readonly string[];
}

interface AiTextAllowance {
  /** The file the word is allowed in, or every file when absent. */
  readonly file?: string;
  readonly word: string;
  readonly reason: string;
}

/**
 * A word of a pack's vocabulary that instruction text may hold anyway, with the reason. A word that is ordinary English in a sentence (not the name of a type, a link or a property of a source) goes here;
 * a file that is domain text by design is named with its file. Each entry says why, and an entry no scanned text uses fails the check, so the list cannot go stale.
 */
const AI_TEXT_ALLOWLIST: readonly AiTextAllowance[] = [
  { word: 'amount', reason: 'ordinary English: how much, in the rules about numbers in an answer' },
  { word: 'claim', reason: 'ordinary English: to assert, in the rules on what a sentence may assert' },
  { word: 'status', reason: 'ordinary English: the status of a request, a record or a turn, in stored text and instructions' },
  { word: 'name', reason: 'ordinary English: the name of a thing or a field' },
  { word: 'number', reason: 'ordinary English: a number the answer states' },
  { word: 'model', reason: 'ordinary English: the model the instructions are written for' },
  { word: 'make', reason: 'ordinary English verb' },
  { file: 'ee/ai-runtime/src/local.ts', word: 'address', reason: 'a network address of the local model service' },
  { file: 'ee/ai-runtime/src/provider-configuration.ts', word: 'owner', reason: 'the owner of a key file on disk' },
  { file: 'ee/ask/src/case-summary/token-keys.ts', word: 'owner', reason: 'the owner of a key file on disk' },
  { file: 'ee/ask/src/case-summary/notes-words.ts', word: 'owner', reason: 'an ordinary English word in the list of words the notes may not use' },
  { file: 'ee/ask/src/case-summary/notes-words.ts', word: 'address', reason: 'an ordinary English word in the list of words the notes may not use' },
  { file: 'ee/ask/src/case-summary/notes-words.ts', word: 'city', reason: 'an ordinary English word in the list of words the notes may not use' },
  { file: 'ee/ask/prompts/aml-typologies.md', word: 'account', reason: 'the shipped typology text is domain text of the AML pack that the operator replaces with a file of their own; moving it into the packs is a separate change' },
  { file: 'ee/ask/prompts/aml-typologies.md', word: 'device', reason: 'the shipped typology text is domain text of the AML pack that the operator replaces with a file of their own; moving it into the packs is a separate change' },
  { file: 'ee/ask/prompts/aml-typologies.md', word: 'address', reason: 'the shipped typology text is domain text of the AML pack that the operator replaces with a file of their own; moving it into the packs is a separate change' },
  { file: 'ee/ask/prompts/aml-typologies.md', word: 'phone', reason: 'the shipped typology text is domain text of the AML pack that the operator replaces with a file of their own; moving it into the packs is a separate change' },
  { file: 'ee/ask/prompts/assistant-router.md', word: 'account', reason: 'open: examples in the router text name a type of the AML pack; changing them re-records the model replays of the router (a live run)' },
  { file: 'ee/ask/prompts/assistant-router.md', word: 'lives_at', reason: 'open: an example in the router text names a link of the AML pack; changing it re-records the model replays of the router (a live run)' },
];


function wordsOf(identifiers: readonly Identifier[]): ReadonlyMap<string, readonly Identifier[]> {
  const byWord = new Map<string, Identifier[]>();
  for (const identifier of identifiers) byWord.set(identifier.name.toLowerCase(), [...(byWord.get(identifier.name.toLowerCase()) ?? []), identifier]);
  return byWord;
}

const usesOf = (identifiers: readonly Identifier[]): string[] => [...new Set(identifiers.map((identifier) => `${identifier.kind} in ${identifier.pack}`))];

/** The pack words in one text: each whole word (letters, digits, underscore) that equals an identifier of a pack, compared without case, with its line. */
function violationsIn(file: string, text: string, firstLine: number, byWord: ReadonlyMap<string, readonly Identifier[]>): AiTextViolation[] {
  const found: AiTextViolation[] = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    for (const match of line.matchAll(/[A-Za-z][A-Za-z0-9_]*/gu)) {
      const identifiers = byWord.get(match[0].toLowerCase());
      if (identifiers !== undefined) found.push({ file, line: firstLine + index, word: match[0].toLowerCase(), uses: usesOf(identifiers) });
    }
  });
  return found;
}

function literalsOf(path: string, text: string): { readonly value: string; readonly line: number }[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKindOf(path));
  const found: { value: string; line: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      const value = node.text;
      if (value.length >= SENTENCE_MIN_LENGTH && /\s/u.test(value)) found.push({ value, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const isTestFile = (path: string): boolean => /\.test\.[cm]?[jt]sx?$/u.test(path) || path.includes('/testing/') || path.includes('/test-support');

/** Every word of a pack's vocabulary that the prompt files or the instruction text in the code of the enterprise extension hold, before the allowlist. */
export function scanAiText(root: string): AiTextViolation[] {
  const byWord = wordsOf(readIdentifiers(root));
  const found: AiTextViolation[] = [];
  for (const folder of AI_TEXT_PROMPT_FOLDERS) {
    if (!existsSync(join(root, folder))) continue;
    for (const entry of readdirSync(join(root, folder)).filter((name) => name.endsWith('.md')).sort()) {
      found.push(...violationsIn(`${folder}/${entry}`, readFileSync(join(root, folder, entry), 'utf8'), 1, byWord));
    }
  }
  for (const file of loadTree(root, { include: AI_TEXT_CODE_ROOTS }).filter((entry) => !isTestFile(entry.path))) {
    for (const literal of literalsOf(file.path, file.text)) found.push(...violationsIn(file.path, literal.value, literal.line, byWord));
  }
  return found;
}

interface AiTextResult {
  readonly violations: readonly AiTextViolation[];
  /** Allowlist entries no scanned text uses. */
  readonly unused: readonly AiTextAllowance[];
}

export function checkAiText(root: string, allowlist: readonly AiTextAllowance[] = AI_TEXT_ALLOWLIST): AiTextResult {
  const scanned = scanAiText(root);
  const allows = (violation: AiTextViolation, entry: AiTextAllowance): boolean => entry.word === violation.word && (entry.file === undefined || entry.file === violation.file);
  const violations = scanned.filter((violation) => !allowlist.some((entry) => allows(violation, entry)));
  const unused = allowlist.filter((entry) => !scanned.some((violation) => allows(violation, entry)));
  return { violations, unused };
}

export function formatAiTextResult(result: AiTextResult): string {
  const lines = result.violations.map((v) => `${v.file}:${v.line} '${v.word}' is ${v.uses.join(' and ')} in instruction text [domain-words:ai-text]`);
  if (result.violations.length > 0) lines.push('Instruction text names no type, link or property of a pack: write it neutrally, take the name from the mapping at run time, or allow an ordinary English word with a reason (docs/architecture-checks.md).');
  for (const entry of result.unused) lines.push(`the allowlist entry '${entry.word}'${entry.file === undefined ? '' : ` for ${entry.file}`} is used by no instruction text: remove it [domain-words:ai-text]`);
  return lines.join('\n');
}

