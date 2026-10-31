import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOpenApiDocument } from './openapi.js';

const target = fileURLToPath(new URL('../openapi.json', import.meta.url));
writeFileSync(target, `${JSON.stringify(buildOpenApiDocument(), null, 2)}\n`);
