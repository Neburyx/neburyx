import { Doc } from './doc.js';

export const readme = new Doc('README.md');

export const stripComment = (command: string): string => command.replace(/\s+#.*$/, '').trim();

const COMMAND_WORDS = /^(docker|cd|cp|openssl) /;

/** The commands of a fenced block, one for each line, except that a command with a here-document, which ends at the line that closes its group, is one command of several lines. */
export function commandsOfBlock(text: string): string[] {
  const commands: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes('<<EOF')) {
      const end = lines.findIndex((candidate, at) => at > index && candidate === ')');
      if (end === -1) throw new Error(`the here-document that starts at "${line}" is not closed by a line that is only ")"`);
      commands.push(lines.slice(index, end + 1).join('\n'));
      index = end;
    } else if (stripComment(line) !== '') {
      commands.push(stripComment(line));
    }
  }
  return commands;
}

export function quickstartOf(doc: Doc) {
  const start = doc.headings().find((heading) => heading.level === 2 && heading.text === 'Quickstart');
  const end = doc.headings().find((heading) => heading.level === 2 && heading.line > (start?.line ?? 0));
  const inside = (line: number): boolean => start !== undefined && line > start.line && line < (end?.line ?? doc.lines.length + 1);
  const fenced = (): string[] => doc.blocks().filter((block) => block.info === 'bash' && inside(block.line)).flatMap((block) => commandsOfBlock(block.text));
  const commands = (): string[] => {
    const inline = doc.lines.flatMap((line, index) => (inside(index + 1) && !line.trimStart().startsWith('```') ? [...line.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? '').filter((span) => COMMAND_WORDS.test(span)) : []));
    return [...fenced(), ...inline];
  };
  return { inside, fenced, commands };
}

const own = quickstartOf(readme);
export const inQuickstart = own.inside;
export const quickstartCommands = own.commands;
export const fencedCommands = own.fenced;
