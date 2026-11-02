import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDefinition } from '../definition.js';
import { readMappingSource } from '../mapping.js';

const MINI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'mini');

export const miniMappingPath = join(MINI, 'neburyx.yaml');
export const miniDefinitionPath = join(MINI, 'demo.yaml');
export const miniMapping = readMappingSource(miniMappingPath);
export const miniDefinitionText = readFileSync(miniDefinitionPath, 'utf8');
export const miniDefinition = parseDefinition(miniDefinitionText, miniMapping);
