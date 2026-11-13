import { rebuildPlannerText } from './rebuild.js';

export interface QuestionWordsInput {
  readonly fileText: string;
  readonly label: string;
  readonly vocabulary: readonly string[];
  readonly commonWords: readonly string[];
}

export interface QuestionWordsResult {
  readonly lines: number;
  readonly misses: readonly string[];
}

function missesOf(text: string, input: QuestionWordsInput): readonly string[] {
  if (text.trim() === '') return [];
  const result = rebuildPlannerText({ text, spans: [], vocabulary: input.vocabulary, commonWords: input.commonWords });
  return result.kind === 'blocked' ? result.tokens.map((token) => token.text) : [];
}

/**
 * Checks the words listed on the lines that hold the label, with the matcher the rebuild uses. The text before the first `;` on
 * such a line is a comma-separated word list; the text after it, past its first `:`, is a window phrase.
 */
export function checkQuestionWords(input: QuestionWordsInput): QuestionWordsResult {
  const misses = new Set<string>();
  let lines = 0;
  for (const line of input.fileText.split(/\r?\n/)) {
    const at = line.indexOf(input.label);
    if (at < 0) continue;
    lines += 1;
    const [wordPart = '', ...rest] = line.slice(at + input.label.length).split(';');
    const phrasePart = rest.join(';');
    for (const word of wordPart.split(',')) for (const miss of missesOf(word.trim(), input)) misses.add(miss);
    if (phrasePart !== '') for (const miss of missesOf(phrasePart.slice(phrasePart.indexOf(':') + 1).trim(), input)) misses.add(miss);
  }
  return { lines, misses: [...misses] };
}

export interface CommandIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly readText: (path: string) => string;
}

const USAGE = 'usage: check-question-words <file> --label <text> --common-words <file> [--vocabulary <file>] [--count-only]';

interface CommandArguments {
  readonly file: string;
  readonly label: string;
  readonly commonWords: string;
  readonly vocabulary?: string;
  readonly countOnly: boolean;
}

function parseArguments(args: readonly string[]): CommandArguments | undefined {
  const values = new Map<string, string>();
  const positional: string[] = [];
  let countOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    if (arg === '--count-only') countOnly = true;
    else if (arg === '--label' || arg === '--common-words' || arg === '--vocabulary') values.set(arg, args[++index] ?? '');
    else positional.push(arg);
  }
  const [file] = positional;
  const label = values.get('--label');
  const commonWords = values.get('--common-words');
  if (positional.length !== 1 || file === undefined || label === undefined || label === '' || commonWords === undefined || commonWords === '') return undefined;
  const vocabulary = values.get('--vocabulary');
  return { file, label, commonWords, ...(vocabulary === undefined ? {} : { vocabulary }), countOnly };
}

const linesOf = (text: string): string[] => text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

/** Runs the check as a command and returns the exit code: 0 for no miss, 1 for a miss or an unreadable or empty input, 2 for a usage error. */
export function runQuestionWordsCommand(args: readonly string[], io: CommandIo): number {
  const parsed = parseArguments(args);
  if (parsed === undefined) {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  let input: QuestionWordsInput;
  try {
    input = {
      fileText: io.readText(parsed.file),
      label: parsed.label,
      vocabulary: parsed.vocabulary === undefined ? [] : linesOf(io.readText(parsed.vocabulary)),
      commonWords: linesOf(io.readText(parsed.commonWords)),
    };
  } catch {
    io.stderr('a file could not be read\n');
    return 1;
  }
  const result = checkQuestionWords(input);
  if (result.lines === 0) {
    io.stderr('the file has no line with the label\n');
    return 1;
  }
  io.stdout(`${result.misses.length} misses\n`);
  if (!parsed.countOnly) for (const miss of result.misses) io.stdout(`${miss}\n`);
  return result.misses.length === 0 ? 0 : 1;
}
