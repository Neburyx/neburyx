import { gzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const ENTRIES = ['baseline', 'cytoscape', 'sigma'] as const;

async function measure(entry: string): Promise<{ readonly bytes: number; readonly gzipBytes: number }> {
  const result = await build({
    root: PACKAGE_ROOT,
    logLevel: 'silent',
    configFile: false,
    build: { write: false, minify: true, lib: { entry: resolve(PACKAGE_ROOT, `src/bundles/${entry}.ts`), formats: ['es'], fileName: entry } },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => ('output' in item ? item.output : []));
  const chunks = outputs.flatMap((output) => (output.type === 'chunk' ? [Buffer.from(output.code)] : []));
  const total = Buffer.concat(chunks);
  return { bytes: total.length, gzipBytes: gzipSync(total).length };
}

async function main(): Promise<void> {
  const sizes = new Map<string, { bytes: number; gzipBytes: number }>();
  for (const entry of ENTRIES) sizes.set(entry, await measure(entry));
  const baseline = sizes.get('baseline');
  for (const [entry, size] of sizes) {
    const own = entry === 'baseline' ? size : { bytes: size.bytes - (baseline?.bytes ?? 0), gzipBytes: size.gzipBytes - (baseline?.gzipBytes ?? 0) };
    process.stdout.write(`${entry}: ${size.bytes} bytes, ${size.gzipBytes} gzip; attributable to the renderer: ${own.bytes} bytes, ${own.gzipBytes} gzip\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'UNEXPECTED_ERROR'}\n`);
  process.exitCode = 1;
});
