import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env['NEBURYX_DEV_API_URL'];
const proxy: Record<string, string> = api === undefined ? {} : { '/v1': api, '/healthz': api, '/readyz': api };

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  define: { __DEV_TOOLS__: JSON.stringify(mode !== 'production') },
  server: { host: '127.0.0.1', proxy },
}));
