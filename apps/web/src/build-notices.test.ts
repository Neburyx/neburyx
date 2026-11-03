// @vitest-environment node
import { join } from 'node:path';
import { build } from 'vite';
import { describe, expect, it } from 'vitest';

describe('a production build of the web app', () => {
  it('carries the third-party notices with the fonts and icons it bundles', async () => {
    const result = await build({ root: join(import.meta.dirname, '..'), mode: 'production', logLevel: 'silent', build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => ('output' in item ? item.output : []));
    const notices = outputs.find((output) => output.fileName === 'THIRD-PARTY-NOTICES.md');
    expect(notices?.type).toBe('asset');
    const text = notices?.type === 'asset' && typeof notices.source === 'string' ? notices.source : '';
    expect(text).toContain('SIL Open Font License');
    expect(text).toContain('Lucide Icons and Contributors');
  });
});
