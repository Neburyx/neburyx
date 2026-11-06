import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSupportServer } from './support-server.ts';

const [folder, port] = process.argv.slice(2);
if (folder === undefined || port === undefined) throw new Error('usage: serve.ts <built web folder> <port>');
const profile: { sourceId: string; entityTypes: { type: string }[] } = JSON.parse(readFileSync(new URL('../fixtures/profile.json', import.meta.url), 'utf8'));
createSupportServer({ root: resolve(folder), profile }).listen(Number(port), '127.0.0.1');
