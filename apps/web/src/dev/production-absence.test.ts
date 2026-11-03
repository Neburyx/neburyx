// @vitest-environment node
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

interface Piece {
  readonly name: 'generator' | 'loader' | 'route' | 'stand-ins';
  readonly module: string;
  readonly marker: string;
}

const PIECES: readonly Piece[] = [
  { name: 'generator', module: '/src/dev/fixture-graph', marker: 'neburyx-dev-fixture-generator' },
  { name: 'loader', module: '/src/dev/fixture-loader', marker: 'neburyx-dev-fixture-loader' },
  { name: 'route', module: '/src/dev/fixture-page', marker: 'neburyx-dev-fixture-route' },
  { name: 'stand-ins', module: '/src/dev/stand-ins', marker: 'neburyx-dev-stand-ins' },
];

const ROOT = join(import.meta.dirname, '..', '..');

interface Built {
  readonly moduleIds: readonly string[];
  readonly text: string;
}

async function built(options: { readonly mode: string; readonly entry?: string }): Promise<Built> {
  const result = await build({
    root: ROOT,
    mode: options.mode,
    logLevel: 'silent',
    build: {
      write: false,
      minify: true,
      ...(options.entry === undefined ? {} : { lib: { entry: join(ROOT, options.entry), formats: ['es'], fileName: 'control' } }),
    },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => ('output' in item ? item.output : []));
  const moduleIds = outputs.flatMap((output) => (output.type === 'chunk' ? output.moduleIds : []));
  const text = outputs.map((output) => (output.type === 'chunk' ? output.code : typeof output.source === 'string' ? output.source : '')).join('\n');
  return { moduleIds, text };
}

function piecesIn(output: Built): string[] {
  return PIECES.filter((piece) => output.moduleIds.some((id) => id.includes(piece.module)) || output.text.includes(piece.marker)).map((piece) => piece.name);
}

describe('a production build of the web app', () => {
  it('holds none of the fixture loader, the fixture generator, the fixture route and the slot stand-ins: no module of theirs and no marker in any emitted file', async () => {
    const production = await built({ mode: 'production' });
    expect(production.moduleIds.length).toBeGreaterThan(0);
    expect(piecesIn(production)).toEqual([]);
  }, 120_000);

  it('does hold all four in a development build, so the check has something to find', async () => {
    expect(piecesIn(await built({ mode: 'development' })).sort()).toEqual(['generator', 'loader', 'route', 'stand-ins']);
  }, 120_000);

  it.each([
    ['generator', 'src/dev/controls/generator.ts', ['generator']],
    ['loader', 'src/dev/controls/loader.ts', ['generator', 'loader']],
    ['route', 'src/dev/controls/route.ts', ['generator', 'loader', 'route', 'stand-ins']],
    ['stand-ins', 'src/dev/controls/stand-ins.ts', ['stand-ins']],
  ] as const)('is caught by the same check when a production-optimized build includes the %s (and what it imports)', async (_name, entry, expected) => {
    const control = await built({ mode: 'production', entry });
    expect(piecesIn(control).sort()).toEqual([...expected].sort());
  }, 120_000);
});
