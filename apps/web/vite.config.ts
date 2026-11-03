import { defineConfig } from 'vite';

const api = process.env['NEBURYX_DEV_API_URL'];

export default defineConfig({
  server: { host: '127.0.0.1', proxy: api === undefined ? {} : { '/v1': api, '/healthz': api, '/readyz': api } },
});
