import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { renderStored } from './render-record.js';

// the entry of `pnpm bench:render`: it fails, and so exits non-zero, when the stored data cannot be rendered
it('renders the benchmark record again from the stored run', () => {
  renderStored(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../docs/benchmarks'));
});
