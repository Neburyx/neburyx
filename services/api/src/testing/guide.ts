import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DOCS_FOLDER = fileURLToPath(new URL('../../../../docs/', import.meta.url));
export const GUIDE_PATH = `${DOCS_FOLDER}mapping-guide.md`;

export interface GuideBlock {
  readonly info: string;
  readonly heading: string;
  readonly line: number;
  readonly text: string;
  readonly marker: string | undefined;
}

export const guideText = (): string => readFileSync(GUIDE_PATH, 'utf8');

const MARKER = /^<!-- (.+) -->$/;

export function guideBlocks(): GuideBlock[] {
  const lines = guideText().split('\n');
  const found: GuideBlock[] = [];
  let heading = '';
  let marker: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = /^```(.*)$/.exec(line);
    if (fence === null) {
      if (/^#{1,6} /.test(line)) heading = line.replace(/^#+ /, '');
      marker = MARKER.exec(line)?.[1] ?? (line.trim() === '' ? marker : undefined);
      continue;
    }
    const start = index;
    const body: string[] = [];
    index += 1;
    while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
      body.push(lines[index] ?? '');
      index += 1;
    }
    found.push({ info: (fence[1] ?? '').trim(), heading, line: start + 1, text: body.join('\n'), marker });
    marker = undefined;
  }
  return found;
}

export function guideTable(marker: string): string[][] {
  const lines = guideText().split('\n');
  const at = lines.indexOf(`<!-- ${marker} -->`);
  if (at < 0) throw new Error(`the guide has no table marked ${marker}`);
  const rows: string[][] = [];
  for (let index = at + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '' && rows.length === 0) continue;
    if (!line.startsWith('|')) break;
    rows.push(line.slice(1, line.lastIndexOf('|')).split('|').map((cell) => cell.trim()));
  }
  return rows.slice(2);
}

export const unticked = (cell: string): string => cell.replace(/^`/, '').replace(/`$/, '');
