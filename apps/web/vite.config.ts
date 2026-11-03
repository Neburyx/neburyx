import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const api = process.env['NEBURYX_DEV_API_URL'];
const proxy: Record<string, string> = api === undefined ? {} : { '/v1': api, '/healthz': api, '/readyz': api };

/** The fonts and icons in the build carry licences that must travel with them. */
const thirdPartyNotices: Plugin = {
  name: 'third-party-notices',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'THIRD-PARTY-NOTICES.md', source: readFileSync(new URL('../../THIRD-PARTY-NOTICES.md', import.meta.url), 'utf8') });
  },
};

export default defineConfig(({ mode }) => ({
  plugins: [react(), thirdPartyNotices],
  define: { __DEV_TOOLS__: JSON.stringify(mode !== 'production') },
  server: { host: '127.0.0.1', proxy },
}));
