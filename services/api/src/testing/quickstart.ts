import { Doc } from './doc.js';

export const readme = new Doc('README.md');

export const stripComment = (command: string): string => command.replace(/\s+#.*$/, '').trim();

const COMMAND_WORDS = /^(docker|cd|cp|openssl) /;

export function quickstartOf(doc: Doc) {
  const start = doc.headings().find((heading) => heading.level === 2 && heading.text === 'Quickstart');
  const end = doc.headings().find((heading) => heading.level === 2 && heading.line > (start?.line ?? 0));
  const inside = (line: number): boolean => start !== undefined && line > start.line && line < (end?.line ?? doc.lines.length + 1);
  const fenced = (): string[] => doc.blocks().filter((block) => block.info === 'bash' && inside(block.line)).flatMap((block) => block.text.split('\n').map(stripComment).filter((line) => line !== ''));
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
