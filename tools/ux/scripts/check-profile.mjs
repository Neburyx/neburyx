// Fails when fixtures/profile.json and fixtures/presets-insurance.json are not what the API's profile builder makes of the banking and insurance packs now.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const { parseMapping } = await import(`${root}services/api/dist/mapping/load.js`);
const { buildSourceProfile } = await import(`${root}services/api/dist/registry/profile.js`);
const text = readFileSync(`${root}domain-packs/banking-fraud/neburyx.yaml`, 'utf8');
const made = JSON.stringify(buildSourceProfile(parseMapping(text, 'neburyx.yaml').sources[0]));
const committed = JSON.stringify(JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/profile.json', import.meta.url)), 'utf8')));
const insurance = buildSourceProfile(parseMapping(readFileSync(`${root}domain-packs/insurance-claims/neburyx.yaml`, 'utf8'), 'neburyx.yaml').sources[0]);
const committedPresets = JSON.stringify(JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/presets-insurance.json', import.meta.url)), 'utf8')));
if (made !== committed || JSON.stringify(insurance.presets) !== committedPresets) {
  console.error('PROFILE_OUT_OF_DATE: run `node tools/ux/scripts/make-profile.mjs` after `pnpm build`');
  process.exit(1);
}
