import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface DocBlock {
  readonly info: string;
  readonly heading: string;
  readonly line: number;
  readonly text: string;
}

export interface DocLink {
  readonly text: string;
  readonly target: string;
  readonly line: number;
}

export const slugOf = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');

export class Doc {
  readonly path: string;
  readonly text: string;
  readonly lines: readonly string[];

  constructor(relativePath: string) {
    this.path = resolve(REPOSITORY_ROOT, relativePath);
    this.text = readFileSync(this.path, 'utf8');
    this.lines = this.text.split('\n');
  }

  blocks(): DocBlock[] {
    const found: DocBlock[] = [];
    let heading = '';
    for (let index = 0; index < this.lines.length; index += 1) {
      const line = this.lines[index] ?? '';
      const fence = /^\s*```(.*)$/.exec(line);
      if (fence === null) {
        if (/^#{1,6} /.test(line)) heading = line.replace(/^#+ /, '');
        continue;
      }
      const start = index;
      const body: string[] = [];
      index += 1;
      while (index < this.lines.length && !(this.lines[index] ?? '').trimStart().startsWith('```')) {
        body.push((this.lines[index] ?? '').trimStart());
        index += 1;
      }
      found.push({ info: (fence[1] ?? '').trim(), heading, line: start + 1, text: body.join('\n') });
    }
    return found;
  }

  headings(): { readonly level: number; readonly text: string; readonly line: number }[] {
    const found: { level: number; text: string; line: number }[] = [];
    let inside = false;
    this.lines.forEach((line, index) => {
      if (line.trimStart().startsWith('```')) inside = !inside;
      const heading = inside ? null : /^(#{1,6}) (.+)$/.exec(line);
      if (heading !== null) found.push({ level: (heading[1] ?? '').length, text: heading[2] ?? '', line: index + 1 });
    });
    return found;
  }

  anchors(): string[] {
    return this.headings().map((heading) => slugOf(heading.text));
  }

  links(): DocLink[] {
    const found: DocLink[] = [];
    let inside = false;
    this.lines.forEach((line, index) => {
      if (line.trimStart().startsWith('```')) inside = !inside;
      if (inside) return;
      for (const match of line.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) found.push({ text: match[1] ?? '', target: match[2] ?? '', line: index + 1 });
    });
    return found;
  }

  resolveLink(target: string): { readonly path: string; readonly anchor: string | undefined; readonly exists: boolean; readonly anchorFound: boolean } {
    const [file = '', anchor] = target.split('#');
    const path = file === '' ? this.path : resolve(dirname(this.path), file);
    const exists = existsSync(path);
    const anchorFound = anchor === undefined || (exists && path.endsWith('.md') && new Doc(path.slice(REPOSITORY_ROOT.length)).anchors().includes(anchor));
    return { path, anchor, exists, anchorFound };
  }
}
