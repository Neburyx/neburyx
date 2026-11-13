// Writes fixtures/profile.json from the banking pack with the API's own profile builder (run after `pnpm build`).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { parseMapping } = await import(`${root}services/api/dist/mapping/load.js`);
const { buildSourceProfile } = await import(`${root}services/api/dist/registry/profile.js`);
const text = readFileSync(`${root}domain-packs/banking-fraud/neburyx.yaml`, 'utf8');
const profile = buildSourceProfile(parseMapping(text, 'neburyx.yaml').sources[0]);
writeFileSync(fileURLToPath(new URL('../fixtures/profile.json', import.meta.url)), `${JSON.stringify(profile, null, 2)}\n`);
// The presets of the insurance pack, which the second source of the support server declares.
const insurance = buildSourceProfile(parseMapping(readFileSync(`${root}domain-packs/insurance-claims/neburyx.yaml`, 'utf8'), 'neburyx.yaml').sources[0]);
writeFileSync(fileURLToPath(new URL('../fixtures/presets-insurance.json', import.meta.url)), `${JSON.stringify(insurance.presets, null, 2)}\n`);
